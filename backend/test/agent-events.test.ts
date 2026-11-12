import request from "supertest";
import { afterAll, afterEach, expect, it } from "vitest";

import { setOverrides } from "../src/agents/prompts/registry";
import { createApp } from "../src/app";
import { closePool, type Queryable } from "../src/db";
import { createHub } from "../src/realtime/hub";
import * as events from "../src/repositories/agent-events";
import { aCall, auth, aVideo, runnerWith } from "./agents-helpers";
import { inRollback } from "./db";

afterAll(closePool);
afterEach(() => setOverrides([]));

const appOn = (db: Queryable) => createApp({ db, hub: createHub(10), runner: runnerWith() });
const all = (db: Queryable, agentId: string) => events.list(db, { agentId, limit: 50 });

it("PATCH /ops/config writes one change per agent touched, with the actor from x-actor", async () => {
  await inRollback(async (tx) => {
    const res = await request(appOn(tx)).patch("/ops/config").set(auth).set("x-actor", "claude-code").send({ name_floor: 0.6, extract_model: "opus", dedupe_n: 10 });
    expect(res.status).toBe(200);
    expect(await all(tx, "name")).toMatchObject([{ kind: "change", summary: "name_floor 0.7 → 0.6 for new videos", actor: "claude-code", session_id: null, data: { changes: [{ key: "name_floor", from: 0.7, to: 0.6 }] } }]);
    expect((await all(tx, "extract")).map((e) => e.summary)).toEqual(["dedupe_n 20 → 10, extract_model sonnet → opus for new videos"]);
    expect(await all(tx, "track")).toEqual([]);
  });
});

it("no x-actor → actor unknown; a long or padded one is trimmed to 40 characters", async () => {
  await inRollback(async (tx) => {
    await request(appOn(tx)).patch("/ops/config").set(auth).send({ name_floor: 0.6 });
    await request(appOn(tx)).patch("/ops/config").set(auth).set("x-actor", `  ${"a".repeat(60)} `).send({ name_floor: 0.5 });
    expect((await all(tx, "name")).map((e) => e.actor)).toEqual(["a".repeat(40), "unknown"]);
  });
});

it("a patch that changes nothing writes nothing, and a key going back to its default is a change", async () => {
  await inRollback(async (tx) => {
    const app = appOn(tx);
    await request(app).patch("/ops/config").set(auth).send({ name_floor: 0.7 });
    expect(await all(tx, "name")).toEqual([]);
    await request(app).patch("/ops/config").set(auth).send({ name_floor: 0.6 });
    await request(app).patch("/ops/config").set(auth).send({ name_floor: 0.6 });
    await request(app).patch("/ops/config").set(auth).send({ name_floor: null });
    expect((await all(tx, "name")).map((e) => e.summary)).toEqual(["name_floor 0.6 → 0.7 for new videos", "name_floor 0.7 → 0.6 for new videos"]);
  });
});

it("PATCH /sessions/:id/config says which video", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    await request(appOn(tx)).patch(`/sessions/${v.id}/config`).set(auth).set("x-actor", "admin").send({ track_switch_confidence: 0.9 });
    expect(await all(tx, "track")).toMatchObject([{ summary: "track_switch_confidence 0.8 → 0.9 on Main Stage", session_id: v.id, actor: "admin" }]);
  });
});

it("registering, overwriting and handing back a prompt version are each recorded, and an overwrite keeps the text it replaced", async () => {
  await inRollback(async (tx) => {
    const app = appOn(tx);
    const put = (text: string) => request(app).put("/ops/prompts/extract/v90").set(auth).set("x-actor", "admin").send({ text });
    expect((await put("first {{schema}}")).status).toBe(200);
    expect((await put("second {{schema}}")).status).toBe(200);
    expect((await request(app).delete("/ops/prompts/extract/v90").set(auth)).status).toBe(204);
    const got = await all(tx, "extract");
    expect(got.map((e) => e.summary)).toEqual(["Instructions v90 handed back to the file", "Instructions v90 overwritten", "Instructions v90 registered"]);
    expect(got[1]!.data).toEqual({ before: "first {{schema}}" });
    expect(got[2]!.actor).toBe("admin");
  });
});

it("activity merges runs and changes, newest first, and pages by before", async () => {
  await inRollback(async (tx) => {
    const app = appOn(tx);
    const v = await aVideo(tx);
    const first = await aCall(tx, v.id);
    await tx.query("update llm_calls set created_at = now() - interval '3 minutes' where id = $1", [first.id]);
    await request(app).patch("/ops/config").set(auth).set("x-actor", "admin").send({ extract_model: "opus" });
    await tx.query("update agent_events set created_at = now() - interval '2 minutes'");
    const second = await aCall(tx, v.id, { windowT0: 30, windowT1: 60, error: "boom", parsed: null });
    await tx.query("update llm_calls set created_at = now() - interval '1 minute' where id = $1", [second.id]);

    // The shared test database holds other tests' extract calls; only this test's lines are looked at.
    type Line = { kind: string; summary: string; call_id: number | null; at: string };
    const mine = (lines: Line[]) => lines.filter((l) => l.kind !== "call" || l.call_id === first.id || l.call_id === second.id);
    const activity = mine((await request(app).get("/agents/extract/activity?limit=200").set(auth)).body);
    expect(activity.map((a) => [a.kind, a.summary])).toEqual([
      ["call", "Failed: boom"],
      ["change", "extract_model sonnet → opus for new videos"],
      ["call", "No claims"],
    ]);
    expect(activity[0]).toMatchObject({ call_id: second.id, status: "failed", actor: null });
    expect(activity[1]).toMatchObject({ call_id: null, status: null, actor: "admin" });
    const older = mine((await request(app).get(`/agents/extract/activity?limit=200&before=${encodeURIComponent(activity[1]!.at)}`).set(auth)).body);
    expect(older.map((a) => a.kind)).toEqual(["call"]);
    expect((await request(app).get("/agents/extract/activity?limit=1").set(auth)).body).toHaveLength(1);
    expect((await request(app).get("/agents/nope/activity").set(auth)).status).toBe(404);
  });
});

it("GET /calls/:id lists the events about that call", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const call = await aCall(tx, v.id);
    await events.add(tx, { agentId: "extract", sessionId: v.id, callId: call.id, kind: "rerun", summary: "Run again with v6 on sonnet", data: { status: "pending" }, actor: "admin" });
    const res = await request(appOn(tx)).get(`/calls/${call.id}`).set(auth);
    expect(res.body.events).toMatchObject([{ kind: "rerun", summary: "Run again with v6 on sonnet", actor: "admin" }]);
  });
});
