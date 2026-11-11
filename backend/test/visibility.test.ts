import request from "supertest";
import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { createApp } from "../src/app";
import { ExtractConfig } from "../src/contracts";
import { closePool, type Queryable } from "../src/db";
import { createExtractor } from "../src/ingest/extractor";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as people from "../src/repositories/people";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as speakers from "../src/repositories/speakers";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const auth = { authorization: "Bearer test-key" };
const noRunner: SessionRunner = { start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => [], busy: () => [], hold: () => {}, fillGap: () => Promise.resolve(false), pending: () => [], wanted: () => false };
// The test database holds other tests' rows, so every list is read down to this test's own.
const OURS = ["Known Before", "No Session", "On Both", "Test Only"];
const names = (body: { person: { name: string } }[]) => body.map((p) => p.person.name).filter((n) => OURS.includes(n)).sort();

/** A test stage with one talk by two people, a video of it, and one claim heard in that talk. */
async function testRun(db: Queryable) {
  const hub = createHub(100);
  const stage = await stages.create(db, { conference: "Summit", name: "Main", day: "2026-10-06", description: "" });
  const talk = await talks.create(db, stage.id, {
    title: "Tokenization", description: "", kind: "fireside", starts_at: null, ends_at: null,
    speakers: [{ name: "Test Only", org: null, title: null, role: "speaker" }, { name: "On Both", org: null, title: null, role: "speaker" }],
  });
  const session = await sessions.create(db, { sourceUrl: "https://www.youtube.com/watch?v=QB5BNdBFujE", sourceFile: null, config: {}, stageId: stage.id, title: "Summit day" });
  await spans.switchTo(db, session.id, { talkId: talk.id, state: "talk", t: 0, confidence: 0.9, quote: null, source: "tracker", callId: null });
  await speakers.upsert(db, session.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 30 });
  await speakers.setPerson(db, session.id, "S1", { id: talk.speakers[0]!.id, name: "Test Only" });
  const text = "tokenized stocks will pass a trillion dollars";
  await segments.insert(db, session.id, { t0: 5, t1: 10, text, words: text.split(" ").map((w, i) => ({ w, t0: 5 + i * 0.1, t1: 5.1 + i * 0.1, p: 1, speaker_id: "S1" })) });
  const llm = fakeLlm(JSON.stringify({ claims: [{ claim: "Tokenized stocks will pass 1 trillion dollars.", kind: "opinion", importance: 3, topics: ["rwa"], polarity: "bullish", quote: text }] }));
  await createExtractor({ db, hub, sessionId: session.id, llm: llm.client, config: ExtractConfig.parse({}) }).tick();
  return { hub, stage, talk, session };
}

test("hiding a stage takes its videos, sessions, claims and its own speakers out of every list, and keeps them reachable", async () => {
  await inRollback(async (tx) => {
    const { hub, stage, talk, session } = await testRun(tx);
    const real = await stages.create(tx, { conference: "Breakpoint", name: "Main", day: "2026-11-16", description: "" });
    await talks.create(tx, real.id, { title: "Keynote", description: "", kind: "keynote", starts_at: null, ends_at: null, speakers: [{ name: "On Both", org: null, title: null, role: "speaker" }] });
    await people.upsertByName(tx, { name: "No Session" });
    // Someone the app knew before the test stage existed, who then spoke at it.
    const before = await people.upsertByName(tx, { name: "Known Before" });
    await tx.query("update people set created_at = now() - interval '1 day' where id = $1", [before.id]);
    await talks.create(tx, stage.id, { title: "Liquidity", description: "", kind: "panel", starts_at: null, ends_at: null, speakers: [{ name: "Known Before", org: null, title: null, role: "speaker" }] });
    const app = createApp({ db: tx, hub, runner: noRunner });
    const get = (path: string) => request(app).get(path).set(auth);
    const videoIds = async (path: string) => (await get(path)).body.map((v: { session: { id: string } }) => v.session.id).filter((id: string) => id === session.id);
    const feedIds = async (path: string) => (await get(path)).body.items.filter((c: { session_id: string }) => c.session_id === session.id);
    const talkTitles = async () => (await get("/talks")).body.filter((t: { stage: { id: string } }) => [stage.id, real.id].includes(t.stage.id)).map((t: { talk: { title: string } }) => t.talk.title).sort();

    expect(await videoIds("/videos")).toHaveLength(1);
    expect(await feedIds("/feed")).toHaveLength(1);
    expect(await talkTitles()).toEqual(["Keynote", "Liquidity", "Tokenization"]);
    expect(names((await get("/people")).body)).toEqual(OURS);

    const hidden = await request(app).put(`/stages/${stage.id}`).set(auth).send({ conference: "Summit", name: "Main", day: "2026-10-06", hidden: true });
    expect(hidden.body).toMatchObject({ id: stage.id, hidden: true });

    expect(await videoIds("/videos")).toEqual([]);
    expect(await videoIds("/videos?all=1")).toEqual([session.id]);
    expect(await talkTitles()).toEqual(["Keynote"]);
    expect(await feedIds("/feed")).toEqual([]);
    expect(names((await get("/people")).body)).toEqual(["Known Before", "No Session", "On Both"]);
    expect(names((await get("/people?all=1")).body)).toEqual(OURS);
    const testOnly = talk.speakers[0]!;
    expect((await get(`/feed?person=${testOnly.id}`)).body.items).toEqual([]);

    // Asked for by name, everything is still there: the admin can open a test video and its sessions.
    expect((await get(`/talks/${talk.id}`)).body).toMatchObject({ talk: { title: "Tokenization" }, claims: [{ claim: "Tokenized stocks will pass 1 trillion dollars." }] });
    expect((await get(`/feed?session=${session.id}`)).body.items).toHaveLength(1);
    expect((await get(`/people/${testOnly.id}`)).body).toMatchObject({ person: { name: "Test Only" }, talks: [], claims: [] });
    expect((await get(`/stages/${stage.id}`)).body.stage.hidden).toBe(true);

    // A save that does not say stays shown, so an older form cannot hide a stage by accident, and showing brings it all back.
    await request(app).put(`/stages/${stage.id}`).set(auth).send({ conference: "Summit", name: "Main", day: "2026-10-06" });
    expect(await feedIds("/feed")).toHaveLength(1);
    expect(names((await get("/people")).body)).toEqual(OURS);
  });
});

test("a speaker with no session and no voice can be removed; one on a schedule cannot", async () => {
  await inRollback(async (tx) => {
    const { hub, talk } = await testRun(tx);
    const stray = await people.upsertByName(tx, { name: "Payward" });
    const app = createApp({ db: tx, hub, runner: noRunner });
    await request(app).put(`/people/${stray.id}/photo`).set(auth).send({ content_type: "image/png", data: "AAAA" });

    const refused = await request(app).delete(`/people/${talk.speakers[1]!.id}`).set(auth);
    expect([refused.status, refused.body.error]).toEqual([400, expect.stringContaining("on a schedule")]);
    expect((await request(app).delete(`/people/${stray.id}`).set(auth)).status).toBe(204);
    expect(await people.get(tx, stray.id)).toBeNull();
    expect((await request(app).delete(`/people/${stray.id}`).set(auth)).status).toBe(404);
    expect((await request(app).get(`/people/${talk.speakers[1]!.id}`).set(auth)).status).toBe(200);
  });
});
