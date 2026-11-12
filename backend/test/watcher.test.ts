import request from "supertest";
import { afterAll, expect, it } from "vitest";

import { createApp } from "../src/app";
import { closePool, type Queryable } from "../src/db";
import { createWatcher } from "../src/ingest/watcher";
import { createHub } from "../src/realtime/hub";
import * as incidents from "../src/repositories/incidents";
import * as sessions from "../src/repositories/sessions";
import * as settings from "../src/repositories/settings";
import { buildSnapshot } from "../src/routes/snapshot";
import { aCall, auth, aVideo, runnerWith } from "./agents-helpers";
import { inRollback } from "./db";

afterAll(closePool);

const up = async () => ({ proxy: true, speech: true });

/** Other test files leave degraded videos behind in the shared test database; inside this transaction they are put to rest. */
const calm = (tx: Queryable) => tx.query("update sessions set status = 'stopped', attention = null where status = 'degraded' or attention is not null");

/** A live video the runner holds, with `n` failed extract runs. */
async function failingVideo(tx: Queryable, n = 3) {
  const v = await aVideo(tx);
  await sessions.setStatus(tx, v.id, "live");
  for (let i = 0; i < n; i++) await aCall(tx, v.id, { windowT0: i * 30, windowT1: (i + 1) * 30, error: "claims: Required", parsed: null });
  return v;
}
const open = (tx: Queryable) => incidents.list(tx, { open: true, limit: 50 });

it("three failed extract runs on a busy video open one incident; the next pass updates it, not a second one", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await failingVideo(tx);
    const watcher = createWatcher({ db: tx, runner: runnerWith([v.id]), health: up });
    const first = await watcher.pass();
    expect(first?.opened).toHaveLength(1);
    const [incident] = await open(tx);
    expect(incident).toMatchObject({ rule: "agent_failing", agent_id: "extract", session_id: v.id, session_title: "Main Stage", count: 1, title: "Extractor failed 3 times in a row on Main Stage", detail: "claims: Required", diagnosis: null, resolved_at: null });
    expect(incident!.call_id).toBeGreaterThan(0);
    const second = await watcher.pass();
    expect(second).toEqual({ opened: [], resolved: [] });
    expect(await open(tx)).toMatchObject([{ id: incident!.id, count: 2 }]);
  });
});

it("a new watcher (an api restart) seeing the same trouble updates the open incident", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await failingVideo(tx);
    await createWatcher({ db: tx, runner: runnerWith([v.id]), health: up }).pass();
    expect((await createWatcher({ db: tx, runner: runnerWith([v.id]), health: up }).pass())?.opened).toEqual([]);
    expect(await open(tx)).toHaveLength(1);
  });
});

it("an incident closes itself after clear_passes clean passes, and reopens as a new row if it returns", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await failingVideo(tx);
    const watcher = createWatcher({ db: tx, runner: runnerWith([v.id]), health: up });
    await watcher.pass();
    const [first] = await open(tx);
    await aCall(tx, v.id, { windowT0: 90, windowT1: 120 });
    expect((await watcher.pass())?.resolved).toEqual([]);
    expect((await watcher.pass())?.resolved).toEqual([]);
    expect((await watcher.pass())?.resolved).toEqual([first!.id]);
    expect(await open(tx)).toEqual([]);
    for (let i = 0; i < 3; i++) await aCall(tx, v.id, { windowT0: 120 + i * 30, windowT1: 150 + i * 30, error: "again", parsed: null });
    const again = await watcher.pass();
    expect(again?.opened).toHaveLength(1);
    expect(again!.opened[0]).not.toBe(first!.id);
  });
});

it("a clean pass in between does not close it: the count of clean passes starts over", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    await settings.put(tx, "watcher", { clear_passes: 2 });
    const v = await aVideo(tx);
    await sessions.setStatus(tx, v.id, "live");
    const watcher = createWatcher({ db: tx, runner: runnerWith([v.id]), health: up });
    await sessions.setAttention(tx, v.id, "speech unreachable");
    await watcher.pass();
    await sessions.setAttention(tx, v.id, null);
    await watcher.pass();
    await sessions.setAttention(tx, v.id, "speech unreachable");
    await watcher.pass();
    await sessions.setAttention(tx, v.id, null);
    expect((await watcher.pass())?.resolved).toEqual([]);
    expect((await watcher.pass())?.resolved).toHaveLength(1);
  });
});

it("with the proxy down the agent's incident is stored under the proxy's", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await failingVideo(tx);
    const watcher = createWatcher({ db: tx, runner: runnerWith([v.id]), health: async () => ({ proxy: false, speech: true }) });
    await settings.put(tx, "watcher", { probe_passes: 1 });
    await watcher.pass();
    const all = await open(tx);
    const proxy = all.find((i) => i.rule === "proxy_down");
    expect(proxy).toBeDefined();
    expect(all.find((i) => i.rule === "agent_failing")?.parent_id).toBe(proxy!.id);
  });
});

it("a pass that throws is survived: the next pass runs", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await failingVideo(tx);
    let broken = true;
    const flaky = { query: ((...args: unknown[]) => (broken ? Promise.reject(new Error("connection reset")) : (tx.query as (...a: unknown[]) => unknown)(...args))) as Queryable["query"] } as Queryable;
    const watcher = createWatcher({ db: flaky, runner: runnerWith([v.id]), health: up });
    expect(await watcher.pass()).toEqual({ opened: [], resolved: [] });
    broken = false;
    expect((await watcher.pass())?.opened).toHaveLength(1);
  });
});

it("two passes at once: the second answers null", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const watcher = createWatcher({ db: tx, runner: runnerWith(), health: up });
    const [a, b] = await Promise.all([watcher.pass(), watcher.pass()]);
    expect(a).toEqual({ opened: [], resolved: [] });
    expect(b).toBeNull();
    expect(await watcher.pass()).not.toBeNull();
  });
});

it("enabled false: no pass", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await failingVideo(tx);
    await settings.put(tx, "watcher", { enabled: false });
    expect(await createWatcher({ db: tx, runner: runnerWith([v.id]), health: up }).pass()).toBeNull();
    expect(await open(tx)).toEqual([]);
  });
});

it("a video nobody holds is watched only when degraded or needing attention, and a replay never", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const idle = await failingVideo(tx);
    const degraded = await aVideo(tx, { title: "Stage 2" });
    await sessions.setStatus(tx, degraded.id, "degraded");
    const replay = await aVideo(tx, { title: "Replay", replayOf: degraded.id });
    await sessions.setStatus(tx, replay.id, "degraded");
    await createWatcher({ db: tx, runner: runnerWith(), health: up }).pass();
    const all = await open(tx);
    expect(all.map((i) => [i.rule, i.session_id])).toEqual([["video_degraded", degraded.id]]);
    expect(all.some((i) => i.session_id === idle.id)).toBe(false);
  });
});

it("POST /incidents/:id/resolve takes it off the open list without letting the same trouble be reported again", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await failingVideo(tx);
    const watcher = createWatcher({ db: tx, runner: runnerWith([v.id]), health: up });
    await watcher.pass();
    const app = createApp({ db: tx, hub: createHub(10), runner: runnerWith() });
    const listed = await request(app).get("/incidents?open=1").set(auth);
    expect(listed.body).toHaveLength(1);
    const id = listed.body[0].id;
    expect((await request(app).post(`/incidents/${id}/resolve`).set(auth)).body).toMatchObject({ id, acknowledged_at: expect.any(String) });
    expect((await request(app).get("/incidents?open=1").set(auth)).body).toEqual([]);
    expect((await request(app).get("/incidents").set(auth)).body).toHaveLength(1);
    expect((await request(app).get("/agents").set(auth)).body[2]).toMatchObject({ open_incidents: 0 });
    expect((await watcher.pass())?.opened).toEqual([]);
    expect((await request(app).get("/incidents?open=1").set(auth)).body).toEqual([]);
    expect((await request(app).post(`/incidents/999999999/resolve`).set(auth)).status).toBe(404);
  });
});

it("a video's snapshot leaves the Watcher's calls out of calls and cost_usd", async () => {
  await inRollback(async (tx) => {
    await calm(tx);
    const v = await aVideo(tx);
    const mine = await aCall(tx, v.id, { costUsd: 0.5 });
    await aCall(tx, v.id, { step: "watch", costUsd: 1 });
    const snapshot = await buildSnapshot(tx, createHub(10), v);
    expect(snapshot.calls.map((c) => c.id)).toEqual([mine.id]);
    expect(snapshot.cost_usd).toBeCloseTo(0.5);
  });
});
