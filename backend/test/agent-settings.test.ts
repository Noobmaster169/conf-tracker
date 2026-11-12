import request from "supertest";
import { afterAll, afterEach, expect, it } from "vitest";

import { setOverrides } from "../src/agents/prompts/registry";
import { createApp } from "../src/app";
import { closePool, type Queryable } from "../src/db";
import { createHub } from "../src/realtime/hub";
import * as events from "../src/repositories/agent-events";
import * as gaps from "../src/repositories/gaps";
import * as sessions from "../src/repositories/sessions";
import * as settings from "../src/repositories/settings";
import { auth, aVideo, runnerWith } from "./agents-helpers";
import { inRollback } from "./db";

afterAll(closePool);
afterEach(() => setOverrides([]));

const patch = (db: Queryable, busy: string[], agent: string, body: object) =>
  request(createApp({ db, hub: createHub(10), runner: runnerWith(busy) })).patch(`/agents/${agent}/settings`).set(auth).set("x-actor", "admin").send(body);
const configOf = async (db: Queryable, id: string) => (await sessions.get(db, id))!.config;

it("apply all: the default config and a running video both change, and both are recorded", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const res = await patch(tx, [v.id], "name", { set: { name_floor: 0.6 }, apply: "all" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ default_changed: true, sessions: [{ id: v.id, title: "Main Stage" }], waits_for_next_start: [] });
    expect(await settings.defaultConfig(tx)).toEqual({ name_floor: 0.6 });
    expect(await configOf(tx, v.id)).toEqual({ name_floor: 0.6 });
    expect((await events.list(tx, { agentId: "name", limit: 10 })).map((e) => [e.summary, e.actor]).sort()).toEqual([
      ["name_floor 0.7 → 0.6 for new videos", "admin"],
      ["name_floor 0.7 → 0.6 on Main Stage", "admin"],
    ]);
  });
});

it("apply defaults to all", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    expect((await patch(tx, [v.id], "name", { set: { name_floor: 0.6 } })).body).toMatchObject({ default_changed: true, sessions: [{ id: v.id }] });
  });
});

it("apply running reaches an ended video that still has an open gap, and leaves the default alone", async () => {
  await inRollback(async (tx) => {
    const live = await aVideo(tx);
    const ended = await aVideo(tx, { title: "Ended with a gap" });
    await sessions.setStatus(tx, ended.id, "stopped");
    await gaps.add(tx, ended.id, 100, 200);
    const done = await aVideo(tx, { title: "Ended, nothing owed" });
    await sessions.setStatus(tx, done.id, "stopped");
    const res = await patch(tx, [live.id], "extract", { set: { extract_model: "opus" }, apply: "running" });
    expect(res.body.default_changed).toBe(false);
    expect(res.body.sessions.map((s: { title: string }) => s.title).sort()).toEqual(["Ended with a gap", "Main Stage"]);
    expect(await settings.defaultConfig(tx)).toEqual({});
    expect(await configOf(tx, ended.id)).toEqual({ extract_model: "opus" });
    expect(await configOf(tx, done.id)).toEqual({});
  });
});

it("apply new leaves running videos alone", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const res = await patch(tx, [v.id], "extract", { set: { extract_model: "opus" }, apply: "new" });
    expect(res.body).toMatchObject({ default_changed: true, sessions: [] });
    expect(await configOf(tx, v.id)).toEqual({});
  });
});

it("a key owned by another agent → 400 and nothing changed anywhere", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const res = await patch(tx, [v.id], "name", { set: { name_floor: 0.6, extract_model: "opus" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/extract_model/);
    expect(await settings.defaultConfig(tx)).toEqual({});
    expect(await configOf(tx, v.id)).toEqual({});
    expect(await events.list(tx, { agentId: "name", limit: 10 })).toEqual([]);
  });
});

it("one bad value among good ones → 400 and nothing changed anywhere", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const res = await patch(tx, [v.id], "name", { set: { name_window_s: 120, name_floor: 2 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name_floor/);
    expect(await settings.defaultConfig(tx)).toEqual({});
    expect(await configOf(tx, v.id)).toEqual({});
  });
});

it("a prompt version that does not exist → 400; one that does is accepted", async () => {
  await inRollback(async (tx) => {
    expect((await patch(tx, [], "extract", { set: { extract_prompt: "v99" } })).status).toBe(400);
    expect((await patch(tx, [], "extract", { set: { extract_prompt: "v4" } })).status).toBe(200);
    expect(await settings.defaultConfig(tx)).toEqual({ extract_prompt: "v4" });
  });
});

it("null takes a key back to its default", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx, { config: { name_floor: 0.6, name: true } });
    await settings.put(tx, "default_config", { name_floor: 0.6 });
    expect((await patch(tx, [v.id], "name", { set: { name_floor: null } })).status).toBe(200);
    expect(await settings.defaultConfig(tx)).toEqual({});
    expect(await configOf(tx, v.id)).toEqual({ name: true });
  });
});

it("an interval change is reported as waiting for the next start", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    expect((await patch(tx, [v.id], "extract", { set: { extract_interval_s: 45, extract_model: "opus" } })).body.waits_for_next_start).toEqual(["extract_interval_s"]);
  });
});

it("a replay's speed survives a settings change", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx, { config: { speed: 4 } });
    await patch(tx, [v.id], "name", { set: { name_floor: 0.6 } });
    expect(await configOf(tx, v.id)).toEqual({ speed: 4, name_floor: 0.6 });
    expect(await settings.defaultConfig(tx)).toEqual({ name_floor: 0.6 });
  });
});

it("the Watcher's settings are stored once and apply is ignored", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const res = await patch(tx, [v.id], "watch", { set: { fail_runs: 5 }, apply: "running" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ default_changed: true, sessions: [], waits_for_next_start: [] });
    expect((await settings.watchSettings(tx)).fail_runs).toBe(5);
    expect(await configOf(tx, v.id)).toEqual({});
    expect((await patch(tx, [], "watch", { set: { fail_runs: 0 } })).status).toBe(400);
    expect((await patch(tx, [], "watch", { set: { name_floor: 0.5 } })).status).toBe(400);
    expect((await events.list(tx, { agentId: "watch", limit: 10 })).map((e) => e.summary)).toEqual(["fail_runs 3 → 5 for the whole app"]);
  });
});

it("unknown agent → 404; a body without set → 400; nothing to change → 200 and no record", async () => {
  await inRollback(async (tx) => {
    expect((await patch(tx, [], "nope", { set: {} })).status).toBe(404);
    expect((await patch(tx, [], "name", { apply: "all" })).status).toBe(400);
    expect((await patch(tx, [], "name", { set: { name_floor: 0.6 }, apply: "sideways" })).status).toBe(400);
    expect((await patch(tx, [], "name", { set: { name_floor: 0.7 } })).body).toEqual({ default_changed: false, sessions: [], waits_for_next_start: [] });
    expect(await events.list(tx, { agentId: "name", limit: 10 })).toEqual([]);
  });
});
