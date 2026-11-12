import request from "supertest";
import { afterAll, expect, it } from "vitest";

import { createApp } from "../src/app";
import { closePool } from "../src/db";
import { createHub } from "../src/realtime/hub";
import * as claims from "../src/repositories/claims";
import * as settings from "../src/repositories/settings";
import { aCall, auth, aVideo, runnerWith } from "./agents-helpers";
import { inRollback } from "./db";

afterAll(closePool);

const appOn = (db: Parameters<typeof createApp>[0]["db"]) => createApp({ db, hub: createHub(10), runner: runnerWith() });
const get = (app: ReturnType<typeof appOn>, path: string) => request(app).get(path).set(auth);

it("GET /agents lists five cards; one that never ran is idle with an empty strip", async () => {
  await inRollback(async (tx) => {
    await tx.query("delete from llm_calls where step = 'watch'");
    const app = appOn(tx);
    expect((await request(app).get("/agents")).status).toBe(401);
    const res = await get(app, "/agents");
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(["track", "name", "extract", "summarize", "post", "watch"]);
    const watch = res.body[5];
    expect(watch).toMatchObject({ name: "Watcher", internal: true, status: "idle", recent: [], last_run_at: null, open_incidents: 0, prompt_version: "v1", model: "haiku" });
    expect(res.body[4]).toMatchObject({ name: "Poster", internal: false, prompt_version: "v1", model: "opus", trigger: "When a session's summary is written." });
    expect(res.body[2]).toMatchObject({ name: "Extractor", role: "Pulls the claims out of what is said on stage.", prompt_version: "v5", model: "sonnet", trigger: "Every 30 seconds of stream." });
  });
});

it("GET /agents: newest run failed → status failed; strip holds at most 24, oldest first", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    for (let i = 0; i < 25; i++) await aCall(tx, v.id, { windowT0: i * 30, windowT1: (i + 1) * 30 });
    await aCall(tx, v.id, { windowT0: 750, windowT1: 780, error: "boom", parsed: null });
    const card = (await get(appOn(tx), "/agents")).body[2];
    expect(card.status).toBe("failed");
    expect(card.recent).toHaveLength(24);
    expect(card.recent.at(-1)).toBe("failed");
    expect(card.recent[0]).toBe("ok");
    expect(typeof card.last_run_at).toBe("string");
  });
});

it("GET /agents: an open incident makes an agent failed even when its last run was fine; a slow last run is slow", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    await aCall(tx, v.id);
    await aCall(tx, v.id, { step: "track", latencyMs: 70_000 });
    await tx.query("insert into incidents (rule, agent_id, session_id, title) values ('agent_failing', 'extract', $1, 't')", [v.id]);
    const cards = (await get(appOn(tx), "/agents")).body;
    expect(cards[2]).toMatchObject({ status: "failed", open_incidents: 1 });
    expect(cards[0]).toMatchObject({ status: "slow" });
  });
});

it("GET /agents/name reports each setting with its default, stored value and fixed_at_start", async () => {
  await inRollback(async (tx) => {
    await settings.put(tx, "default_config", { name_floor: 0.6 });
    const res = await get(appOn(tx), "/agents/name");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "name", settings_scope: "video", prompt_key: "name_prompt", model_key: "name_model", reads: expect.any(Array), writes: ["a name for a voice"] });
    const by = Object.fromEntries(res.body.settings.map((s: { key: string }) => [s.key, s]));
    expect(by.name_floor).toEqual({ key: "name_floor", value: 0.6, default: 0.7, fixed_at_start: false, valid: true });
    expect(by.name_interval_s).toMatchObject({ value: 60, default: 60, fixed_at_start: true });
    expect(res.body.instructions.find((i: { version: string }) => i.version === "v3")).toMatchObject({ source: "file", in_use: true, exists: true });
    expect(res.body.instructions.filter((i: { in_use: boolean }) => i.in_use)).toHaveLength(1);
  });
});

it("GET /agents/extract still answers when the default config names a prompt version that does not exist, and when a value is invalid", async () => {
  await inRollback(async (tx) => {
    await settings.put(tx, "default_config", { extract_prompt: "v99", dedupe_n: "many" });
    const res = await get(appOn(tx), "/agents/extract");
    expect(res.status).toBe(200);
    expect(res.body.prompt_version).toBe("v99");
    expect(res.body.instructions.find((i: { version: string }) => i.version === "v99")).toMatchObject({ in_use: true, exists: false });
    expect(res.body.settings.find((s: { key: string }) => s.key === "dedupe_n")).toMatchObject({ value: "many", default: 20, valid: false });
    expect((await get(appOn(tx), "/agents")).status).toBe(200);
  });
});

it("GET /agents/watch reads the Watcher's own settings", async () => {
  await inRollback(async (tx) => {
    await settings.put(tx, "watcher", { fail_runs: 5 });
    const res = await get(appOn(tx), "/agents/watch");
    expect(res.body.settings_scope).toBe("global");
    expect(res.body.settings.find((s: { key: string }) => s.key === "fail_runs")).toMatchObject({ value: 5, default: 3 });
  });
});

it("GET /agents/nope → 404", async () => {
  await inRollback(async (tx) => {
    expect((await get(appOn(tx), "/agents/nope")).status).toBe(404);
    expect((await get(appOn(tx), "/agents/nope/calls")).status).toBe(404);
  });
});

it("GET /agents/extract/calls filters by session and status, pages with before, and carries result lines", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const other = await aVideo(tx, { title: "Stage 2" });
    const a = await aCall(tx, v.id, { windowT1: 30 });
    const claim = { speakerId: null, t0: 1, t1: 2, claim: "c", topics: [], polarity: "none" as const, kind: "fact" as const, importance: 2, quote: "q", quoteVerified: true, status: "ok" as const };
    await claims.insertMany(tx, v.id, a.id, [claim, claim, claim]);
    const b = await aCall(tx, v.id, { windowT0: 30, windowT1: 60, error: "claims: Required", parsed: null });
    const c = await aCall(tx, v.id, { windowT0: 60, windowT1: 90, latencyMs: 70_000 });
    await aCall(tx, other.id);
    const app = appOn(tx);
    const all = (await get(app, `/agents/extract/calls?session=${v.id}`)).body;
    expect(all.map((r: { id: number }) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(all.map((r: { result: string }) => r.result)).toEqual(["No claims", "Failed: claims: Required", "3 claims"]);
    expect(all.map((r: { status: string }) => r.status)).toEqual(["slow", "failed", "ok"]);
    expect(all[0]).toMatchObject({ session_title: "Main Stage", prompt_version: "v5", model: "sonnet" });
    expect(all[0].input).toBeUndefined();
    expect((await get(app, `/agents/extract/calls?session=${v.id}&status=failed`)).body.map((r: { id: number }) => r.id)).toEqual([b.id]);
    expect((await get(app, `/agents/extract/calls?session=${v.id}&status=slow`)).body.map((r: { id: number }) => r.id)).toEqual([c.id]);
    expect((await get(app, `/agents/extract/calls?session=${v.id}&status=weird`)).body).toHaveLength(3);
    expect((await get(app, `/agents/extract/calls?session=${v.id}&limit=1&before=${c.id}`)).body.map((r: { id: number }) => r.id)).toEqual([b.id]);
    expect((await get(app, `/agents/extract/calls?session=not-a-uuid`)).status).toBe(400);
  });
});

it("GET /calls/:id answers the run's attempts and its one-line result", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const first = await aCall(tx, v.id, { error: "claims: Required", parsed: null, input: "first input" });
    const second = await aCall(tx, v.id, { attempt: 2, input: "first input\n\n## your previous answer" });
    const res = await get(appOn(tx), `/calls/${second.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: "No claims", status: "ok", events: [], claims: [], proposals: [] });
    expect(res.body.call.id).toBe(second.id);
    expect(res.body.attempts.map((c: { id: number }) => c.id)).toEqual([first.id, second.id]);
    expect(res.body.attempts[0].input).toBe("first input");
  });
});
