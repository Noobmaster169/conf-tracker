import request from "supertest";
import { afterAll, expect, test } from "vitest";

import { createApp } from "../src/app";
import type { LiveEvent } from "../src/contracts";
import { closePool, type Queryable } from "../src/db";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import * as feed from "../src/repositories/feed";
import * as people from "../src/repositories/people";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as speakers from "../src/repositories/speakers";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const auth = { authorization: "Bearer test-key" };
const runnerWith = (live: string[] = []): SessionRunner => ({ start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => live, busy: () => live, hold: () => {} });

/** A video on a stage with one scheduled session, two voices and a claim from each. */
async function setUp(db: Queryable) {
  const stage = await stages.create(db, { conference: "Accelerate", name: "Main stage", day: "2026-05-05", description: "" });
  const talk = await talks.create(db, stage.id, {
    title: "Fireside", description: "", kind: "fireside", starts_at: "14:15", ends_at: null,
    speakers: [{ name: "Jacqueline Reses", org: "Lead", title: null, role: "speaker" }],
  });
  const session = await sessions.create(db, { sourceUrl: URL, sourceFile: null, config: {}, stageId: stage.id, title: "Day one" });
  await speakers.upsert(db, session.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 60 });
  await speakers.upsert(db, session.id, { speakerId: "S2", firstSeenT: 5, lastSeenT: 50 });
  const call = await calls.insert(db, session.id, {
    step: "extract", promptVersion: "v5", model: "sonnet", windowT0: 0, windowT1: 30, attempt: 1, input: "x", output: "{}", parsed: {},
    inputTokens: 1, outputTokens: 1, costUsd: 0.001, latencyMs: 5, error: null,
  });
  const [first, second] = await claims.insertMany(db, session.id, call.id, [
    { speakerId: "S1", t0: 10, t1: 12, claim: "Lead was the first bank with on-chain products.", topics: ["banking"], polarity: "neutral", quote: "q1", quoteVerified: true, status: "ok", kind: "fact", importance: 2 },
    { speakerId: "S2", t0: 20, t1: 22, claim: "Stablecoin yield was settled last week.", topics: ["stablecoins"], polarity: "neutral", quote: "q2", quoteVerified: true, status: "ok", kind: "fact", importance: 3 },
  ]);
  return { stage, talk, session, call, first: first!, second: second! };
}

test("a voice is named by hand: by a name the schedule knows, by person id, cleared, and merged into another", async () => {
  await inRollback(async (tx) => {
    const { session, first } = await setUp(tx);
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    hub.subscribe(session.id, (e) => seen.push(e));
    const app = createApp({ db: tx, hub, runner: runnerWith() });
    const put = (sid: string, body: unknown) => request(app).put(`/sessions/${session.id}/speakers/${sid}`).set(auth).send(body as object);

    expect((await request(app).put(`/sessions/${session.id}/speakers/S1`).send({ name: "x" })).status).toBe(401);
    expect((await put("S9", { name: "x" })).status).toBe(404);
    expect((await put("S1", {})).body.error).toMatch(/exactly one of/);
    expect((await put("S1", { name: "x", merge_into: "S2" })).status).toBe(400);
    expect((await put("S1", { person_id: 999999 })).body.error).toBe("no such person");

    // The name is the scheduled person's, so the voice is linked to her and her claim follows.
    const named = await put("S1", { name: "jacqueline reses" });
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({ speaker_id: "S1", name: "Jacqueline Reses", role: "Lead", name_confidence: 1, name_quote: null });
    expect(named.body.person_id).toEqual(expect.any(Number));
    expect(seen.map((e) => e.type)).toEqual(["person", "speaker"]);
    const item = (await feed.list(tx, { session: session.id, limit: 50 })).items.find((c) => c.id === first.id);
    expect(item?.person?.name).toBe("Jacqueline Reses");
    // A name given by hand is not replaced by a model's proposal, however sure.
    expect(await speakers.setName(tx, session.id, "S1", { name: "Someone Else", role: null, confidence: 0.99, quote: "q", callId: first.call_id })).toBeNull();

    const blue = await people.upsertByName(tx, { name: "Blue Macellari", org: "T. Rowe Price", title: null });
    expect((await put("S2", { person_id: blue.id })).body).toMatchObject({ name: "Blue Macellari", person_id: blue.id, role: "T. Rowe Price" });

    expect((await put("S2", { name: null })).body).toMatchObject({ name: null, person_id: null, role: null, name_confidence: null });

    // S2 was the same woman all along: her name passes to nobody new, and S2's claim reads as hers.
    expect((await put("S2", { merge_into: "S7" })).body.error).toMatch(/no speaker S7/);
    const merged = await put("S2", { merge_into: "S1" });
    expect(merged.body).toMatchObject({ speaker_id: "S2", merged_into: "S1" });
    expect((await put("S2", { merge_into: "S1" })).body.error).toMatch(/already one speaker/);
    const after = (await feed.list(tx, { session: session.id, limit: 50 })).items;
    expect(after.map((c) => c.person?.name)).toEqual(["Jacqueline Reses", "Jacqueline Reses"]);
  });
});

test("a claim is corrected field by field, moved to another voice, and deleted", async () => {
  await inRollback(async (tx) => {
    const { session, first, second } = await setUp(tx);
    const app = createApp({ db: tx, hub: createHub(10), runner: runnerWith() });
    const patch = (id: number, body: unknown) => request(app).patch(`/claims/${id}`).set(auth).send(body as object);

    expect((await request(app).patch(`/claims/${first.id}`).send({ importance: 4 })).status).toBe(401);
    expect((await patch(0, { importance: 4 })).status).toBe(404);
    expect((await patch(first.id, {})).body.error).toMatch(/nothing to change/);
    expect((await patch(first.id, { importance: 9 })).status).toBe(400);
    expect((await patch(first.id, { kind: "rumour" })).status).toBe(400);
    expect((await patch(first.id, { speaker_id: "S9" })).body.error).toMatch(/no speaker S9/);

    const fixed = await patch(first.id, { claim: "Lead says it was the first bank with on-chain products.", kind: "opinion", importance: 1, topics: ["banking", "lead"], polarity: "none" });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ id: first.id, claim: "Lead says it was the first bank with on-chain products.", kind: "opinion", importance: 1, topics: ["banking", "lead"], polarity: "none", speaker_id: "S1", quote: "q1", t0: 10 });
    expect((await patch(first.id, { speaker_id: "S2" })).body).toMatchObject({ speaker_id: "S2", kind: "opinion" });
    expect((await patch(first.id, { speaker_id: null })).body.speaker_id).toBeNull();

    expect((await request(app).delete(`/claims/${second.id}`).set(auth)).status).toBe(204);
    expect((await request(app).delete(`/claims/${second.id}`).set(auth)).status).toBe(404);
    expect((await claims.list(tx, session.id, {})).map((c) => c.id)).toEqual([first.id]);
  });
});

test("a video is renamed, and deleted with everything stored for it once it is neither running nor replayed", async () => {
  await inRollback(async (tx) => {
    const { stage, talk, session, call } = await setUp(tx);
    await segments.insert(tx, session.id, { t0: 0, t1: 5, text: "hello", words: [{ w: "hello", t0: 0, t1: 1, p: 1, speaker_id: "S1" }] });
    await spans.switchTo(tx, session.id, { talkId: talk.id, state: "talk", t: 0, confidence: 0.9, quote: null, source: "admin", callId: null });
    await speakers.setName(tx, session.id, "S1", { name: "Jackie", role: null, confidence: 0.8, quote: "q", callId: call.id });
    const replay = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {}, replayOf: session.id, stageId: stage.id, title: "Day one" });
    // A new video is "starting" until speech answers; these two have run and ended.
    for (const id of [session.id, replay.id]) await sessions.setStatus(tx, id, "stopped");
    const hub = createHub(10);
    const live = createApp({ db: tx, hub, runner: runnerWith([session.id]) });
    const app = createApp({ db: tx, hub, runner: runnerWith() });

    const renamed = await request(app).patch(`/sessions/${session.id}`).set(auth).send({ title: "  Accelerate USA  " });
    expect(renamed.body).toMatchObject({ id: session.id, title: "Accelerate USA" });
    expect((await request(app).patch(`/sessions/${session.id}`).set(auth).send({})).status).toBe(400);
    expect((await request(app).patch("/sessions/not-a-uuid").set(auth).send({ title: "x" })).status).toBe(404);

    expect((await request(app).delete(`/sessions/${session.id}`)).status).toBe(401);
    const running = await request(live).delete(`/sessions/${session.id}`).set(auth);
    expect([running.status, running.body.error]).toEqual([409, "session is still running; stop it first"]);
    const replayed = await request(app).delete(`/sessions/${session.id}`).set(auth);
    expect([replayed.status, replayed.body.error]).toEqual([409, "session has 1 replay; delete it first"]);

    expect((await request(app).delete(`/sessions/${replay.id}`).set(auth)).status).toBe(204);
    expect((await request(app).delete(`/sessions/${session.id}`).set(auth)).status).toBe(204);
    expect(await sessions.get(tx, session.id)).toBeNull();
    for (const table of ["claims", "speakers", "segments", "talk_spans", "llm_calls"]) {
      expect((await tx.query(`select 1 from ${table} where session_id = $1`, [session.id])).rowCount, table).toBe(0);
    }
    // The schedule and the people outlive the video.
    expect(await talks.get(tx, talk.id)).not.toBeNull();
    expect((await request(app).delete(`/sessions/${session.id}`).set(auth)).status).toBe(404);
  });
});

test("a stage is deleted with its schedule only when no video is on it; the people stay", async () => {
  await inRollback(async (tx) => {
    const { stage, talk, session } = await setUp(tx);
    const app = createApp({ db: tx, hub: createHub(10), runner: runnerWith() });
    const del = () => request(app).delete(`/stages/${stage.id}`).set(auth);

    expect((await request(app).delete(`/stages/${stage.id}`)).status).toBe(401);
    expect((await request(app).delete("/stages/nope").set(auth)).status).toBe(404);
    const held = await del();
    expect([held.status, held.body.error]).toEqual([400, expect.stringMatching(/has videos/)]);

    await sessions.remove(tx, session.id);
    expect((await del()).status).toBe(204);
    expect(await stages.get(tx, stage.id)).toBeNull();
    expect(await talks.get(tx, talk.id)).toBeNull();
    expect((await tx.query("select 1 from people where lower(name) = 'jacqueline reses'")).rowCount).toBe(1);
    expect((await del()).status).toBe(404);
  });
});
