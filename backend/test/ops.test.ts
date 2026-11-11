import request from "supertest";
import { afterAll, afterEach, expect, test } from "vitest";

import { createApp } from "../src/app";
import { loadPrompt, setOverrides } from "../src/agents/prompts/registry";
import { ExtractConfig } from "../src/contracts";
import { closePool, getPool } from "../src/db";
import { liveConfig, livePrompt } from "../src/ingest/live-config";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as sessions from "../src/repositories/sessions";
import { inRollback } from "./db";

afterAll(closePool);
afterEach(() => setOverrides([]));

const auth = { authorization: "Bearer test-key" };
const runnerWith = (live: string[] = []): SessionRunner => ({ start: (id) => sessions.get(getPool(), id).then((s) => s!), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => live, busy: () => live, hold: () => {} });
const probe = async (url: string) => ({ ok: !url.includes("8100"), detail: url });

test("status shows the api, the proxy, speech, the model calls and what the box last reported", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(10), runner: runnerWith(["abc"]), probe });
    expect((await request(app).get("/ops/status")).status).toBe(401);
    const before = await request(app).get("/ops/status").set(auth);
    expect(before.body).toMatchObject({ api: { live: ["abc"] }, llm_proxy: { ok: true }, box: null });
    expect(Array.isArray(before.body.calls_last_hour)).toBe(true);
    expect(before.body.llm_proxy.detail).toMatch(/\/healthz$/);

    expect((await request(app).post("/ops/box-report").set(auth).send({ deployed: "abc123", disk: "40%" })).status).toBe(204);
    const after = await request(app).get("/ops/status").set(auth);
    expect(after.body.box).toMatchObject({ deployed: "abc123", disk: "40%", stale: false });
  });
});

test("a job is queued, claimed once by the box with its secret, and finished with the secret wiped", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(10), runner: runnerWith() });
    const post = (path: string, body: object = {}) => request(app).post(path).set(auth).send(body);

    expect((await post("/ops/jobs", { verb: "rm -rf" })).body.error).toMatch(/no such verb/);
    expect((await post("/ops/jobs", { verb: "speech-restart" })).status).toBe(400);
    expect((await post("/ops/jobs/claim")).status).toBe(204);

    const created = await post("/ops/jobs", { verb: "set-env", args: { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-secret" } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "queued", args: { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "<hidden>" } });

    const claimed = await post("/ops/jobs/claim");
    expect(claimed.body).toMatchObject({ id: created.body.id, status: "running", args: { value: "sk-secret" } });
    expect((await post("/ops/jobs/claim")).status).toBe(204);

    const done = await post(`/ops/jobs/${created.body.id}/result`, { ok: true, output: "restarted llm-proxy" });
    expect(done.body).toMatchObject({ status: "done", output: "restarted llm-proxy", args: { key: "CLAUDE_CODE_OAUTH_TOKEN" } });
    expect(done.body.args.value).toBeUndefined();
    expect((await post(`/ops/jobs/${created.body.id}/result`, { ok: true })).status).toBe(404);
    expect((await request(app).get("/ops/jobs").set(auth)).body[0]).toMatchObject({ id: created.body.id, status: "done" });
  });
});

test("restarting the api while a video runs needs force, and only this stack's finished videos can lose their recording", async () => {
  await inRollback(async (tx) => {
    const session = await sessions.create(tx, { sourceUrl: null, sourceFile: "a.wav", config: {} });
    const app = createApp({ db: tx, hub: createHub(10), runner: runnerWith([session.id]) });
    const post = (body: object) => request(app).post("/ops/jobs").set(auth).send(body);

    expect((await post({ verb: "restart", args: { service: "api" } })).status).toBe(409);
    expect((await post({ verb: "restart", args: { service: "api", force: true } })).status).toBe(201);
    expect((await post({ verb: "restart", args: { service: "llm-proxy" } })).status).toBe(201);
    expect((await post({ verb: "recordings-clean", args: { session_ids: [session.id] } })).status).toBe(409);
    expect((await post({ verb: "recordings-clean", args: { session_ids: ["6f1c9a52-0b1e-4c57-9d0a-3c1d2e4f5a6b"] } })).body.error).toMatch(/not a video/);
  });
});

test("a prompt version is registered without a build, used by a running video once its config names it, and removed", async () => {
  await inRollback(async (tx) => {
    const session = await sessions.create(tx, { sourceUrl: null, sourceFile: "a.wav", config: {} });
    const hub = createHub(10);
    const app = createApp({ db: tx, hub, runner: runnerWith([session.id]) });
    const shipped = loadPrompt("extract", "v5");
    const initial = ExtractConfig.parse({});

    expect((await request(app).put("/ops/prompts/nope/v9").set(auth).send({ text: "x" })).status).toBe(404);
    expect((await request(app).put("/ops/prompts/extract/v99").set(auth).send({ text: "no slot" })).body.error).toMatch(/schema/);
    expect((await request(app).patch(`/sessions/${session.id}/config`).set(auth).send({ extract_prompt: "v99" })).body.error).toMatch(/no extract prompt v99/);

    const put = await request(app).put("/ops/prompts/extract/v99").set(auth).send({ text: "Only announcements.\n{{schema}}" });
    expect(put.body).toMatchObject({ step: "extract", version: "v99", model: shipped.model, registered: true });
    const listed = (await request(app).get("/ops/prompts").set(auth)).body.find((s: { step: string }) => s.step === "extract");
    expect(listed.default).toBe("v5");
    expect(listed.versions[0]).toMatchObject({ version: "v99", source: "registered" });

    const patched = await request(app).patch(`/sessions/${session.id}/config`).set(auth).send({ extract_prompt: "v99", extract_model: "opus" });
    expect(patched.body.config).toEqual({ extract_prompt: "v99", extract_model: "opus" });
    const live = await liveConfig(tx, session.id, ExtractConfig, initial);
    expect(live).toMatchObject({ extract_prompt: "v99", extract_model: "opus" });
    expect(livePrompt("extract", live.extract_prompt, live.extract_model, shipped)).toMatchObject({ version: "v99", model: "opus", text: "Only announcements.\n{{schema}}" });

    // A null takes the key back to its default.
    const back = await request(app).patch(`/sessions/${session.id}/config`).set(auth).send({ extract_prompt: null, extract_model: null });
    expect(back.body.config).toEqual({});

    expect((await request(app).delete("/ops/prompts/extract/v99").set(auth)).status).toBe(204);
    expect((await request(app).get("/ops/prompts/extract/v99").set(auth)).status).toBe(404);
    // A version that has gone falls back to what the loop started with instead of stopping it.
    expect(livePrompt("extract", "v99", "sonnet", shipped)).toBe(shipped);
  });
});

test("a registered prompt of a shipped version replaces the file's text until it is removed", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(10), runner: runnerWith() });
    const file = loadPrompt("name", "v3");
    await request(app).put("/ops/prompts/name/v3").set(auth).send({ text: `${file.text}\nBe stricter.` });
    expect(loadPrompt("name", "v3").text).toMatch(/Be stricter\.$/);
    expect((await request(app).get("/ops/prompts/name/v3").set(auth)).body.registered).toBe(true);
    await request(app).delete("/ops/prompts/name/v3").set(auth);
    expect(loadPrompt("name", "v3").text).toBe(file.text);
  });
});

test("the starting config of new videos is set through the api and refused when it names nothing real", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(10), runner: { ...runnerWith(), start: (id) => sessions.get(tx, id).then((s) => s!) } });
    expect((await request(app).patch("/ops/config").set(auth).send({ track_prompt: "v77" })).body.error).toMatch(/no track prompt v77/);
    expect((await request(app).patch("/ops/config").set(auth).send({ name_floor: 7 })).status).toBe(400);
    const set = await request(app).patch("/ops/config").set(auth).send({ name_floor: 0.8, extract_model: "opus" });
    expect(set.body.set).toEqual({ name_floor: 0.8, extract_model: "opus" });
    expect(set.body.code_defaults).toMatchObject({ name_floor: 0.7, extract_prompt: "v5", summary_model: "opus" });

    const created = await request(app).post("/sessions").set(auth).send({ file: "a.wav", config: { extract_model: "haiku" } });
    expect(created.body.config).toEqual({ name_floor: 0.8, extract_model: "haiku" });

    expect((await request(app).patch("/ops/config").set(auth).send({ name_floor: null })).body.set).toEqual({ extract_model: "opus" });
  });
});

test("sql reads and cannot write", async () => {
  const app = createApp({ db: getPool(), hub: createHub(10), runner: runnerWith() });
  const sql = (text: string) => request(app).post("/ops/sql").set(auth).send({ sql: text });
  expect((await sql("select 1 + 1 as n")).body).toEqual({ rows: [{ n: 2 }], truncated: false });
  expect((await sql("select generate_series(1, 600)")).body).toMatchObject({ truncated: true });
  const write = await sql("insert into settings (key, value) values ('x', '1')");
  expect(write.status).toBe(400);
  expect(write.body.error).toMatch(/read-only/);
  expect((await sql("select count(*)::int as n from settings where key = 'x'")).body.rows).toEqual([{ n: 0 }]);
});

test("the api's own log lines are kept and filtered", async () => {
  const { childLogger, recentLogs } = await import("../src/lib/logger");
  void childLogger;
  expect(Array.isArray(recentLogs({ limit: 5, level: "warn" }))).toBe(true);
  const app = createApp({ db: getPool(), hub: createHub(10), runner: runnerWith() });
  expect((await request(app).get("/ops/logs?limit=5&level=error").set(auth)).status).toBe(200);
});
