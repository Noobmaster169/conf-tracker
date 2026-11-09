import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import request from "supertest";
import { afterAll, beforeAll, expect, test } from "vitest";

import type { SpeechEvent } from "../src/contracts";
import { createApp } from "../src/app";
import { closePool, getPool } from "../src/db";
import { fakeSpeech } from "../src/ingest/__fakes__/fake-speech";
import { createSessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import * as diarization from "../src/repositories/diarization";
import * as names from "../src/repositories/names";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import { readSse } from "./sse";

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const auth = { authorization: "Bearer test-key" };

const started: SpeechEvent = {
  type: "session.started",
  session_id: "x",
  started_at: "2026-09-23T10:00:00.000Z",
  source: { url: URL },
  models: { asr: "large-v3" },
  config: {},
};
const segmentAt = (t0: number): SpeechEvent => ({ type: "asr.segment", t0, t1: t0 + 1, text: `at ${t0}`, words: [{ w: "at", t0, t1: t0 + 1, p: 1 }] });

const hub = createHub(3);
const speech = fakeSpeech([started, segmentAt(0), segmentAt(5), segmentAt(10), segmentAt(15)], { closeAfter: false });
const runner = createSessionRunner({ db: getPool(), hub, connect: speech.connector });
const app = createApp({ db: getPool(), hub, runner });
let server: Server;

beforeAll(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
});
afterAll(async () => {
  server.close();
  await closePool();
});

test("GET /health needs no key", async () => {
  const res = await request(app).get("/health");
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ status: "ok", live: [] });
});

test("every other route needs the key", async () => {
  expect((await request(app).get("/sessions")).status).toBe(401);
  expect((await request(app).get("/sessions").set("authorization", "Bearer wrong")).status).toBe(401);
});

test("POST /sessions rejects a body with neither url nor file, and a non-YouTube url", async () => {
  const empty = await request(app).post("/sessions").set(auth).send({});
  expect(empty.status).toBe(400);
  expect(empty.body.error).toMatch(/url or file/);
  const vimeo = await request(app).post("/sessions").set(auth).send({ url: "https://vimeo.com/1" });
  expect(vimeo.status).toBe(400);
  expect(vimeo.body.error).toMatch(/YouTube/);
});

test("GET /sessions/:id answers 404 for an unknown id", async () => {
  const res = await request(app).get("/sessions/00000000-0000-0000-0000-000000000000").set(auth);
  expect(res.status).toBe(404);
});

test("a session lives: create, snapshot, transcript, events with stale Last-Event-ID, stop", async () => {
  const created = await request(app).post("/sessions").set(auth).send({ url: URL });
  expect(created.status).toBe(201);
  const id: string = created.body.id;
  expect(created.body.video_id).toBe("QB5BNdBFujE");
  await speech.done;

  const snapshot = await request(app).get(`/sessions/${id}`).set(auth);
  expect(snapshot.status).toBe(200);
  expect(snapshot.body.session.status).toBe("live");
  expect(snapshot.body.segments.map((s: { t0: number }) => s.t0)).toEqual([0, 5, 10, 15]);
  expect(snapshot.body.seq).toBe(5);
  expect(snapshot.body.speakers).toEqual([]);
  expect(snapshot.body.claims).toEqual([]);
  expect(snapshot.body.calls).toEqual([]);

  const transcript = await request(app).get(`/sessions/${id}/transcript?from=4&to=11`).set(auth);
  expect(transcript.body.map((s: { t0: number }) => s.t0)).toEqual([5, 10]);

  // The ring holds 3; seq 1 has fallen out, so the client gets a snapshot first.
  const stale = await readSse(server, `/sessions/${id}/events`, 1, { "last-event-id": "1" });
  expect(stale[0]?.type).toBe("snapshot");

  // seq 3 is still held: only 4 and 5 come back, no snapshot.
  const fresh = await readSse(server, `/sessions/${id}/events`, 2, { "last-event-id": "3" });
  expect(fresh.map((e) => e.seq)).toEqual([4, 5]);

  const listed = await request(app).get("/sessions").set(auth);
  expect(listed.body.map((s: { id: string }) => s.id)).toContain(id);

  const stopped = await request(app).post(`/sessions/${id}/stop`).set(auth);
  expect(stopped.body.status).toBe("stopped");
  expect((await request(app).get("/health")).body.live).toEqual([]);
});

test("the snapshot carries the latest session state", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  hub.publish(row.id, { type: "session", data: { ...row, status: "degraded" } });
  const res = await request(app).get(`/sessions/${row.id}`).set(auth);
  expect(res.status).toBe(200);
  expect(res.body.session.status).toBe("degraded");
});

test("an SSE client that disconnects is unsubscribed", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  const first = await readSse(server, `/sessions/${row.id}/events`, 1);
  expect(first[0]?.type).toBe("snapshot");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const health = { t: 1, lag_s: 0.5, gpu_ms_asr: 100, gpu_ms_diar: 0, buffer_s: 2, received_at: "2026-09-23T10:00:00.000Z" };
  expect(() => hub.publish(row.id, { type: "health", data: health })).not.toThrow();
  const second = await readSse(server, `/sessions/${row.id}/events`, 1);
  expect(second[0]?.type).toBe("snapshot");
  expect(second[0]?.type === "snapshot" ? second[0].data.health : null).toEqual(health);
});

test("GET /sessions/:id/speakers/:sid answers the speaker and its windows, 404 otherwise", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  await speakers.upsert(getPool(), row.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 5, talkS: 5 });
  const match = (id: string) => ({ local: `L${id}`, speech_s: 5, speaker_id: id, scores: {}, new: false });
  await diarization.insertWindow(getPool(), row.id, { t0: 0, t1: 10, gpuMs: 100, matches: [match("S1")], turns: [{ t0: 0, t1: 5, speaker_id: "S1" }] });
  await diarization.insertWindow(getPool(), row.id, { t0: 10, t1: 20, gpuMs: 100, matches: [match("S2")], turns: [{ t0: 10, t1: 15, speaker_id: "S2" }] });

  const found = await request(app).get(`/sessions/${row.id}/speakers/S1`).set(auth);
  expect(found.status).toBe(200);
  expect(found.body.speaker.speaker_id).toBe("S1");
  expect(found.body.windows).toHaveLength(1);

  const unknownSpeaker = await request(app).get(`/sessions/${row.id}/speakers/S9`).set(auth);
  expect(unknownSpeaker.status).toBe(404);
  expect(unknownSpeaker.body).toEqual({ error: "speaker not found" });

  const unknownSession = await request(app).get(`/sessions/${randomUUID()}/speakers/S1`).set(auth);
  expect(unknownSession.status).toBe(404);
  expect(unknownSession.body).toEqual({ error: "session not found" });
});

const seedCall = async (sessionId: string, error: string | null = null) =>
  calls.insert(getPool(), sessionId, {
    step: "extract", promptVersion: "v1", model: "sonnet", windowT0: 0, windowT1: 30, attempt: 1, input: "## new lines\n[00:01 S1] rates will fall",
    output: error ? null : '{"claims":[]}', parsed: error ? null : { claims: [] }, inputTokens: error ? null : 10, outputTokens: error ? null : 2,
    costUsd: error ? null : 0.001, latencyMs: 500, error,
  });

test("GET /sessions/:id/claims filters by time and keeps unverified ones; the snapshot carries claims and calls", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  const call = await seedCall(row.id);
  await claims.insertMany(getPool(), row.id, call.id, [
    { speakerId: "S1", t0: 1, t1: 3, claim: "early", topics: ["rates"], polarity: "bearish", quote: "rates will fall", quoteVerified: true, status: "ok" },
    { speakerId: "S1", t0: 40, t1: 42, claim: "late", topics: [], polarity: "none", quote: "x", quoteVerified: true, status: "ok" },
    { speakerId: null, t0: null, t1: null, claim: "nowhere", topics: [], polarity: "none", quote: "y", quoteVerified: false, status: "unverified" },
  ]);
  await seedCall(row.id, "llm-proxy unreachable");

  const all = await request(app).get(`/sessions/${row.id}/claims`).set(auth);
  expect(all.status).toBe(200);
  expect(all.body.map((c: { claim: string }) => c.claim)).toEqual(["early", "late", "nowhere"]);
  const some = await request(app).get(`/sessions/${row.id}/claims?from=10&to=50`).set(auth);
  expect(some.body.map((c: { claim: string }) => c.claim)).toEqual(["late", "nowhere"]);
  expect((await request(app).get(`/sessions/${row.id}/claims?from=abc`).set(auth)).status).toBe(400);
  expect((await request(app).get(`/sessions/${randomUUID()}/claims`).set(auth)).status).toBe(404);

  const snapshot = await request(app).get(`/sessions/${row.id}`).set(auth);
  expect(snapshot.body.claims.map((c: { claim: string }) => c.claim)).toEqual(["early", "late", "nowhere"]);
  expect(snapshot.body.calls.map((c: { claim_count: number; error: string | null }) => [c.claim_count, c.error])).toEqual([[3, null], [0, "llm-proxy unreachable"]]);
});

test("GET /calls/:id answers the call with its claims, 404 otherwise", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  const call = await seedCall(row.id);
  await claims.insertMany(getPool(), row.id, call.id, [
    { speakerId: "S1", t0: 1, t1: 3, claim: "early", topics: ["rates"], polarity: "bearish", quote: "rates will fall", quoteVerified: true, status: "ok" },
  ]);
  const found = await request(app).get(`/calls/${call.id}`).set(auth);
  expect(found.status).toBe(200);
  expect(found.body.call).toMatchObject({ id: call.id, input: "## new lines\n[00:01 S1] rates will fall", output: '{"claims":[]}', claim_count: 1 });
  expect(found.body.claims.map((c: { claim: string }) => c.claim)).toEqual(["early"]);
  expect((await request(app).get("/calls/987654321").set(auth)).status).toBe(404);
  expect((await request(app).get("/calls/abc").set(auth)).status).toBe(404);
  expect((await request(app).get(`/calls/${call.id}`)).status).toBe(401);
});

test("POST /sessions rejects an extraction config it cannot honour", async () => {
  const badValue = await request(app).post("/sessions").set(auth).send({ url: URL, config: { extract_interval_s: 0 } });
  expect(badValue.status).toBe(400);
  expect(badValue.body.error).toMatch(/extract_interval_s/);
  const badPrompt = await request(app).post("/sessions").set(auth).send({ url: URL, config: { extract_prompt: "v99" } });
  expect(badPrompt.status).toBe(400);
  expect(badPrompt.body.error).toMatch(/v99/);
});

test("GET /sessions/:id/topics counts topics in a range, 400 for a bad range, 404 for an unknown session", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  const call = await seedCall(row.id);
  await claims.insertMany(getPool(), row.id, call.id, [
    { speakerId: "S1", t0: 10, t1: 12, claim: "a", topics: ["rates", "fed"], polarity: "bearish", quote: "q", quoteVerified: true, status: "ok" },
    { speakerId: "S1", t0: 20, t1: 22, claim: "b", topics: ["rates"], polarity: "none", quote: "q", quoteVerified: true, status: "ok" },
    { speakerId: "S1", t0: 700, t1: 702, claim: "c", topics: ["oil"], polarity: "none", quote: "q", quoteVerified: true, status: "ok" },
  ]);
  const res = await request(app).get(`/sessions/${row.id}/topics?from=0&to=600`).set(auth);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ from: 0, to: 600, topics: [{ topic: "rates", count: 2 }, { topic: "fed", count: 1 }] });
  expect((await request(app).get(`/sessions/${row.id}/topics?from=x`).set(auth)).status).toBe(400);
  expect((await request(app).get(`/sessions/${row.id}/topics?limit=0`).set(auth)).status).toBe(400);
  expect((await request(app).get(`/sessions/${randomUUID()}/topics`).set(auth)).status).toBe(404);
});

test("a speaker's detail and a naming call's detail carry the name proposals; the snapshot carries the session cost", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  await speakers.upsert(getPool(), row.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 5, talkS: 5 });
  const call = await seedCall(row.id);
  await seedCall(row.id, "llm-proxy unreachable");
  await names.insertMany(getPool(), row.id, call.id, [
    { speakerId: "S1", name: "Cathie Wood", role: null, confidence: 0.9, quote: "rates will fall", quoteVerified: true, status: "accepted", reason: null },
  ]);
  const detail = await request(app).get(`/sessions/${row.id}/speakers/S1`).set(auth);
  expect(detail.body.proposals.map((p: { name: string; status: string }) => [p.name, p.status])).toEqual([["Cathie Wood", "accepted"]]);
  const callDetail = await request(app).get(`/calls/${call.id}`).set(auth);
  expect(callDetail.body.proposals).toHaveLength(1);
  const snapshot = await request(app).get(`/sessions/${row.id}`).set(auth);
  expect(snapshot.body.cost_usd).toBeCloseTo(0.001);
});

test("POST /sessions rejects a naming config it cannot honour", async () => {
  const badFloor = await request(app).post("/sessions").set(auth).send({ url: URL, config: { name_floor: 3 } });
  expect(badFloor.status).toBe(400);
  expect(badFloor.body.error).toMatch(/name_floor/);
  const badPrompt = await request(app).post("/sessions").set(auth).send({ url: URL, config: { name_prompt: "v99" } });
  expect(badPrompt.status).toBe(400);
  expect(badPrompt.body.error).toMatch(/name prompt v99/);
});

test("GET /claims gathers repeated keys, filters across sessions, and refuses bad values", async () => {
  const row = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  const call = await calls.insert(getPool(), row.id, {
    step: "extract", promptVersion: "v2", model: "sonnet", windowT0: 0, windowT1: 30, attempt: 1, input: "x", output: "{}", parsed: {},
    inputTokens: 1, outputTokens: 1, costUsd: 0.001, latencyMs: 5, error: null,
  });
  await claims.insertMany(getPool(), row.id, call.id, [
    { speakerId: null, t0: 1, t1: 2, claim: "rates fall", topics: ["rates"], polarity: "bearish", quote: "q", quoteVerified: true, status: "ok" },
    { speakerId: null, t0: 3, t1: 4, claim: "oil rises", topics: ["oil"], polarity: "bullish", quote: "q", quoteVerified: true, status: "ok" },
    { speakerId: null, t0: 5, t1: 6, claim: "gold flat", topics: ["gold"], polarity: "neutral", quote: "q", quoteVerified: true, status: "ok" },
  ]);
  expect((await request(app).get("/claims")).status).toBe(401);
  const res = await request(app).get(`/claims?session=${row.id}&topic=rates&topic=oil`).set(auth);
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(2);
  expect(res.body.items.map((c: { claim: string }) => c.claim)).toEqual(["rates fall", "oil rises"]);
  expect(res.body.shows).toEqual([expect.objectContaining({ session_id: row.id, video_id: "QB5BNdBFujE", count: 2 })]);
  const one = await request(app).get(`/claims?session=${row.id}&topic=gold`).set(auth);
  expect(one.body.items.map((c: { claim: string }) => c.claim)).toEqual(["gold flat"]);
  for (const bad of ["polarity=up", "session=nope", "limit=0", "limit=501", "offset=-1", "all=yes", "as_of=abc", "q=a&q=b", "limit=1&limit=2"]) {
    const refused = await request(app).get(`/claims?${bad}`).set(auth);
    expect(refused.status, bad).toBe(400);
    expect(refused.body.error, bad).toMatch(new RegExp(`^${bad.split("=")[0]}: `));
  }
});

test("replay makes a new session of the same video with merged config and speed 0 by default; a speed in the config is ignored", async () => {
  const original = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: { match_threshold: 0.6, extract_model: "haiku" } });
  await sessions.setStatus(getPool(), original.id, "stopped");

  const replay = await request(app).post(`/sessions/${original.id}/replay`).set(auth).send({ config: { match_threshold: 0.65, extract_model: null, speed: -1 } });
  expect(replay.status).toBe(201);
  expect(replay.body.id).not.toBe(original.id);
  expect(replay.body.replay_of).toBe(original.id);
  expect(replay.body.source_url).toBe(original.source_url);
  expect(replay.body.config).toEqual({ match_threshold: 0.65, speed: 0 });
  expect(speech.starts.at(-1)).toMatchObject({ session_id: replay.body.id, replay_of: original.id });
  expect(speech.starts.at(-1)?.url).toBeUndefined();
  await request(app).post(`/sessions/${replay.body.id}/stop`).set(auth);
});

test("replay of a live session is a 409, of an unknown one a 404", async () => {
  const original = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  await sessions.setStatus(getPool(), original.id, "live");
  const running = await request(app).post(`/sessions/${original.id}/replay`).set(auth).send({});
  expect(running.status).toBe(409);
  expect(running.body).toEqual({ error: "session is still running" });
  await sessions.setStatus(getPool(), original.id, "stopped");

  const unknown = await request(app).post("/sessions/00000000-0000-0000-0000-000000000000/replay").set(auth).send({});
  expect(unknown.status).toBe(404);
});

test("replay refuses a bad merged config with the key named", async () => {
  const original = await sessions.create(getPool(), { sourceUrl: URL, sourceFile: null, config: {} });
  await sessions.setStatus(getPool(), original.id, "stopped");
  const refused = await request(app).post(`/sessions/${original.id}/replay`).set(auth).send({ config: { extract_prompt: "v99" } });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/extract prompt v99/);
});
