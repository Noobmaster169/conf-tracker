import request from "supertest";
import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { createApp } from "../src/app";
import { type LiveEvent, NameConfig, TrackConfig } from "../src/contracts";
import { closePool, type Queryable } from "../src/db";
import { createExtractor } from "../src/ingest/extractor";
import { createNamer } from "../src/ingest/namer";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createSummarizer } from "../src/ingest/summarizer";
import { createTracker } from "../src/ingest/tracker";
import { ExtractConfig } from "../src/contracts";
import { createHub } from "../src/realtime/hub";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as speakers from "../src/repositories/speakers";
import * as stages from "../src/repositories/stages";
import * as summaries from "../src/repositories/summaries";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const auth = { authorization: "Bearer test-key" };
const noRunner: SessionRunner = { start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => [], busy: () => [] };

const say = (db: Queryable, sessionId: string, t0: number, text: string, speaker: string | null = "S1") =>
  segments.insert(db, sessionId, { t0, t1: t0 + 5, text, words: text.split(" ").map((w, i) => ({ w, t0: t0 + i * 0.1, t1: t0 + i * 0.1 + 0.1, p: 1, speaker_id: speaker })) });

async function setUp(db: Queryable) {
  const stage = await stages.create(db, { conference: "Breakpoint", name: "Main stage", day: "2026-11-10", description: "The Solana conference." });
  const keynote = await talks.create(db, stage.id, {
    title: "Opening keynote", description: "", kind: "keynote", starts_at: "10:00", ends_at: "10:30",
    speakers: [{ name: "Anatoly Yakovenko", org: "Solana Labs", title: "Co-Founder", role: "speaker" }],
  });
  const panel = await talks.create(db, stage.id, {
    title: "The state of DeFi", description: "", kind: "panel", starts_at: "10:30", ends_at: null,
    speakers: [{ name: "Jane Doe", org: "Acme", title: "CEO", role: "speaker" }],
  });
  const session = await sessions.create(db, { sourceUrl: URL, sourceFile: null, config: {}, stageId: stage.id, title: "Breakpoint day 1" });
  return { stage, keynote, panel, session };
}

const trackAnswer = (talkId: number | null, quote: string, confidence = 0.95) =>
  JSON.stringify({ state: talkId === null ? "break" : "talk", talk_id: talkId, confidence, quote });
const article = "# **Firedancer** Ships in Q1\n\nAnatoly Yakovenko laid out the roadmap.\n\n## What Comes Next\n\nFiredancer is next.";

test("the tracker follows the schedule, dates a switch to its evidence, and a finished talk gets its summary", async () => {
  await inRollback(async (tx) => {
    const { keynote, panel, session } = await setUp(tx);
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    hub.subscribe(session.id, (e) => seen.push(e));
    const llm = fakeLlm((req) => {
      if (req.system.includes("executive summary")) return article;
      if (req.user.includes("state of DeFi panel")) return trackAnswer(panel.id, "next up is the state of DeFi panel");
      return trackAnswer(keynote.id, "please welcome Anatoly Yakovenko");
    });
    const config = TrackConfig.parse({ track_interval_s: 60 });
    const tracker = createTracker({ db: tx, hub, sessionId: session.id, llm: llm.client, config, summarize: createSummarizer({ db: tx, llm: llm.client }) });

    await say(tx, session.id, 10, "please welcome Anatoly Yakovenko", "S9");
    await say(tx, session.id, 20, "Firedancer ships in the first quarter");
    await tracker.tick();
    expect(await spans.list(tx, session.id)).toMatchObject([{ talk_id: keynote.id, state: "talk", t0: 10, t1: null, source: "tracker" }]);
    expect(llm.requests[0]?.user).toContain(`T${keynote.id} | 10:00-10:30 | keynote | "Opening keynote" | speakers: Anatoly Yakovenko (Co-Founder, Solana Labs) | not yet seen`);
    expect(llm.requests[0]?.user).toContain("## current belief\nnothing identified yet");

    // No new speech: the same window is not asked about twice.
    await tracker.tick();
    expect(llm.requests).toHaveLength(1);

    await say(tx, session.id, 400, "thank you Anatoly and next up is the state of DeFi panel", "S9");
    await say(tx, session.id, 410, "lending volumes doubled this year", "S2");
    await tracker.tick();
    await tracker.flush();
    const timeline = await spans.list(tx, session.id);
    expect(timeline.map((s) => [s.talk_id, s.t0, s.t1])).toEqual([[keynote.id, 10, 400], [panel.id, 400, 415]]);
    expect(seen.filter((e) => e.type === "span")).toHaveLength(4);
    // The keynote ran six and a half minutes and is summarised; the panel's fifteen seconds are not a talk worth one.
    // The article is kept whole, and its headline is lifted out of the first heading for the lists.
    expect((await summaries.latest(tx, keynote.id))?.summary).toEqual({ headline: "Firedancer Ships in Q1", content: article });
    expect(await summaries.latest(tx, panel.id)).toBeNull();
    const summaryRequest = llm.requests.find((r) => r.system.includes("executive summary"));
    // A six-minute talk asks for the short article, on the strongest model, as free text.
    expect(summaryRequest).toMatchObject({ model: "opus", maxTokens: 8192 });
    expect(summaryRequest?.outputSchema).toBeUndefined();
    expect(summaryRequest?.system).toContain("(400-800 words)");
    expect(summaryRequest?.user).toContain('Session: "Opening keynote" (keynote)\nSpeakers: Anatoly Yakovenko (Co-Founder, Solana Labs)\nDuration: ~1 minutes\n\nTranscript:\n[00:10 S9] please welcome');
    expect(summaryRequest?.user).toContain("Firedancer ships in the first quarter");
    expect(summaryRequest?.user).not.toContain("lending volumes");
  });
});

test("extraction is told what is on stage, a named voice becomes the scheduled person, and the pages read it all back", async () => {
  await inRollback(async (tx) => {
    const { stage, keynote, panel, session } = await setUp(tx);
    const hub = createHub(100);
    await spans.switchTo(tx, session.id, { talkId: keynote.id, state: "talk", t: 0, confidence: 0.9, quote: null, source: "tracker", callId: null });
    await speakers.upsert(tx, session.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 30 });
    await say(tx, session.id, 5, "I'm Anatoli Yakovenko and we ship Firedancer in the first quarter");

    const naming = fakeLlm(JSON.stringify({ proposals: [{ speaker_id: "S1", name: "Anatoly Yakovenko", role: "Co-Founder, Solana Labs", confidence: 0.95, quote: "I'm Anatoli Yakovenko" }] }));
    await createNamer({ db: tx, hub, sessionId: session.id, llm: naming.client, config: NameConfig.parse({}) }).tick();
    expect(naming.requests[0]?.user).toContain("## scheduled speakers\nAnatoly Yakovenko, Co-Founder, Solana Labs (current session)\nJane Doe, CEO, Acme");
    const anatoly = keynote.speakers[0]!;
    expect((await speakers.get(tx, session.id, "S1"))).toMatchObject({ name: "Anatoly Yakovenko", person_id: anatoly.id });

    const extraction = fakeLlm(JSON.stringify({ claims: [{ claim: "Solana Labs will ship Firedancer in Q1.", kind: "roadmap", importance: 4, topics: ["firedancer"], polarity: "bullish", quote: "we ship Firedancer in the first quarter" }] }));
    await createExtractor({ db: tx, hub, sessionId: session.id, llm: extraction.client, config: ExtractConfig.parse({}) }).tick();
    expect(extraction.requests[0]?.user).toContain('## on stage\nConference: Breakpoint, Main stage. The Solana conference.\nSession: "Opening keynote" (keynote)\nSpeakers: Anatoly Yakovenko (Co-Founder, Solana Labs)');
    expect(extraction.requests[0]?.user).toContain("Names on this stage's schedule, spelt correctly: Anatoly Yakovenko, Solana Labs");
    expect(extraction.requests[0]?.user).toContain("[00:05 S1 Anatoly Yakovenko, Solana Labs] I'm Anatoli");

    // On a fast catch-up the tracker is ahead: it has already moved the stage on to the panel at 300 s. A run over
    // a window before that must still be told the keynote was on stage.
    await spans.switchTo(tx, session.id, { talkId: panel.id, state: "talk", t: 300, confidence: 0.9, quote: null, source: "tracker", callId: null });
    await say(tx, session.id, 40, "and fees fall below a cent");
    await say(tx, session.id, 310, "lending volumes doubled this year", "S2");
    const later = fakeLlm(JSON.stringify({ claims: [] }));
    const catchingUp = createExtractor({ db: tx, hub, sessionId: session.id, llm: later.client, config: ExtractConfig.parse({}) });
    await catchingUp.tick(60);
    expect(later.requests[0]?.user).toContain('Session: "Opening keynote" (keynote)');
    await catchingUp.tick(330);
    expect(later.requests[1]?.user).toContain('Session: "The state of DeFi" (panel)');

    const app = createApp({ db: tx, hub, runner: noRunner });
    const feed = await request(app).get(`/feed?session=${session.id}`).set(auth);
    expect(feed.body.items).toMatchObject([
      { claim: "Solana Labs will ship Firedancer in Q1.", kind: "roadmap", importance: 4, person: { name: "Anatoly Yakovenko", org: "Solana Labs" }, talk: { id: keynote.id, title: "Opening keynote" }, video: { video_id: "QB5BNdBFujE", title: "Breakpoint day 1" } },
    ]);
    expect((await request(app).get(`/feed?session=${session.id}&kind=metric`).set(auth)).body.items).toEqual([]);
    expect((await request(app).get("/feed?limit=0").set(auth)).status).toBe(400);

    const video = (await request(app).get("/videos").set(auth)).body.find((v: { session: { id: string } }) => v.session.id === session.id);
    expect(video).toMatchObject({ stage: { id: stage.id, name: "Main stage", day: "2026-11-10" }, now: { id: panel.id, title: "The state of DeFi" }, claim_count: 1 });

    const person = await request(app).get(`/people/${anatoly.id}`).set(auth);
    expect(person.body).toMatchObject({ person: { name: "Anatoly Yakovenko" }, claim_count: 1, talk_count: 1 });
    expect(person.body.claims).toHaveLength(1);
    expect(person.body.talks[0]).toMatchObject({ talk: { id: keynote.id }, session_id: session.id, claim_count: 1 });

    const talk = await request(app).get(`/talks/${keynote.id}`).set(auth);
    expect(talk.body).toMatchObject({ talk: { title: "Opening keynote" }, stage: { conference: "Breakpoint" }, session_id: session.id, t0: 0, t1: 300, summary: null });
    expect(talk.body.claims).toHaveLength(1);
    const snapshot = await request(app).get(`/sessions/${session.id}`).set(auth);
    expect(snapshot.body).toMatchObject({ stage: { id: stage.id }, spans: [{ talk_id: keynote.id }, { talk_id: panel.id }], people: [{ name: "Anatoly Yakovenko" }, { name: "Jane Doe" }] });
    expect(snapshot.body.talks).toHaveLength(2);
  });
});

test("the admin area builds a stage, pastes a schedule, edits a talk, corrects what is on stage and edits a person", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const app = createApp({ db: tx, hub, runner: noRunner });
    const stage = await request(app).post("/stages").set(auth).send({ conference: "Accelerate", name: "Stage 2", day: "2026-05-01" });
    expect(stage.status).toBe(201);
    expect((await request(app).post("/stages").set(auth).send({ conference: "", name: "x" })).status).toBe(400);

    const bad = await request(app).post(`/stages/${stage.body.id}/import`).set(auth).send({ text: "10:00 | Fine\n | no title here" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("line 2: no title");
    const pasted = await request(app).post(`/stages/${stage.body.id}/import`).set(auth).send({ text: "10:00-10:20 | Intro | Raj Gokal, Solana Labs, President\n10:20 | Payments | Jane Smith, Stripe" });
    expect(pasted.status).toBe(201);
    const [intro, payments] = pasted.body;

    const edited = await request(app).put(`/talks/${intro.id}`).set(auth).send({ title: "Welcome", kind: "keynote", starts_at: "10:05", speakers: [{ name: "Raj Gokal" }, { name: "Lily Liu", org: "Solana Foundation", role: "host" }] });
    expect(edited.body).toMatchObject({ title: "Welcome", kind: "keynote", starts_at: "10:05", ends_at: null });
    // Raj was already known, so the edit keeps what the schedule first said about him.
    expect(edited.body.speakers).toMatchObject([{ name: "Raj Gokal", org: "Solana Labs", title: "President", role: "speaker" }, { name: "Lily Liu", role: "host" }]);

    const session = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    expect((await request(app).post(`/sessions/${session.id}/now`).set(auth).send({ talk_id: payments.id })).status).toBe(400);
    expect((await request(app).post(`/sessions/${session.id}/stage`).set(auth).send({ stage_id: stage.body.id })).body.stage_id).toBe(stage.body.id);
    await say(tx, session.id, 100, "hello");
    const now = await request(app).post(`/sessions/${session.id}/now`).set(auth).send({ talk_id: payments.id });
    expect(now.body).toMatchObject({ talk_id: payments.id, t0: 105, source: "admin", state: "talk" });
    const pause = await request(app).post(`/sessions/${session.id}/now`).set(auth).send({ talk_id: null, t: 300 });
    expect(pause.body).toMatchObject({ talk_id: null, state: "break", t0: 300 });
    expect((await spans.list(tx, session.id)).map((s) => [s.talk_id, s.t0, s.t1])).toEqual([[payments.id, 105, 300], [null, 300, null]]);

    expect((await request(app).delete(`/talks/${intro.id}`).set(auth)).status).toBe(204);
    const full = await request(app).get(`/stages/${stage.body.id}`).set(auth);
    expect(full.body.talks.map((t: { title: string }) => t.title)).toEqual(["Payments"]);
    expect(full.body.text).toBe("10:20 | Payments | Jane Smith, Stripe | talk");
    expect(full.body.videos.map((v: { id: string }) => v.id)).toEqual([session.id]);

    const raj = edited.body.speakers[0];
    const person = await request(app).put(`/people/${raj.id}`).set(auth).send({ name: "Raj Gokal", org: "Solana Labs", title: "Co-Founder", photo_url: "https://example.com/raj.jpg" });
    expect(person.body).toEqual({ id: raj.id, name: "Raj Gokal", org: "Solana Labs", title: "Co-Founder", photo_url: "https://example.com/raj.jpg" });
    // Off the schedule: there is nothing to summarise.
    expect((await request(app).post(`/talks/${intro.id}/summary`).set(auth)).status).toBe(404);
    // Last, because the refused write aborts the transaction this test runs in: two people cannot share a name.
    expect((await request(app).put(`/people/${raj.id}`).set(auth).send({ name: "Lily Liu" })).status).toBe(400);
  });
});
