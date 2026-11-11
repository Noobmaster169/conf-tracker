import type { PoolClient } from "pg";
import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import type { LlmRequest } from "../src/agents/llm-client";
import type { SpeechEvent } from "../src/contracts";
import { closePool } from "../src/db";
import { scriptedSpeech } from "../src/ingest/__fakes__/fake-speech";
import { fillGaps } from "../src/ingest/gap-filler";
import { createSessionRunner } from "../src/ingest/session-runner";
import { createSweeper } from "../src/ingest/sweeper";
import { createHub } from "../src/realtime/hub";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import * as gaps from "../src/repositories/gaps";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as speakers from "../src/repositories/speakers";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const NO_CLAIMS = JSON.stringify({ claims: [] });
const noSummary = async () => null;

const started = (start_at: number): SpeechEvent => ({
  type: "session.started", session_id: "x", started_at: "2026-11-16T10:00:00.000Z", source: { url: URL }, models: { asr: "large-v3" }, config: {}, start_at, broadcast_start: null,
});
const seg = (t0: number, text = `g${t0}`): SpeechEvent => ({ type: "asr.segment", t0, t1: t0 + 5, text, words: [{ w: text, t0, t1: t0 + 5, p: 0.9 }] });
const ended = (reason: "error" | "source_ended" | "stopped"): SpeechEvent => ({ type: "session.ended", reason, message: "" });

const say = (db: PoolClient, sessionId: string, t0: number, text = `w${t0}`) =>
  segments.insert(db, sessionId, { t0, t1: t0 + 5, text, words: [{ w: text, t0, t1: t0 + 5, p: 1, speaker_id: "S1" }] });

/** The main legs' answered extract call up to `t1`, with the claims it found, as a stopped video has them. */
async function extracted(db: PoolClient, sessionId: string, t1: number, found: { claim: string; t0: number }[]) {
  const call = await calls.insert(db, sessionId, {
    step: "extract", promptVersion: "v5", model: "m", windowT0: 0, windowT1: t1, attempt: 1, input: "x", output: null, parsed: null,
    inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: null,
  });
  await claims.insertMany(db, sessionId, call.id, found.map((c) => ({
    speakerId: "S1", t0: c.t0, t1: c.t0 + 2, claim: c.claim, topics: [], polarity: "neutral", quote: "q", quoteVerified: true, status: "ok",
  })));
}

/** A stopped video: speech before 400 and after 600, a gap [400, 600] between. */
async function stoppedWithGap(db: PoolClient, config: Record<string, unknown> = {}, stageId: string | null = null) {
  const s = await sessions.create(db, { sourceUrl: URL, sourceFile: null, config, stageId });
  await speakers.upsert(db, s.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 1185 });
  for (let t = 0; t < 400; t += 20) await say(db, s.id, t);
  for (let t = 600; t < 1200; t += 20) await say(db, s.id, t);
  await sessions.setStatus(db, s.id, "stopped");
  const gap = await gaps.add(db, s.id, 400, 600);
  return { s, gap };
}

const gapScript = (startAt = 400, reason: "source_ended" | "error" = "source_ended") => ({
  events: [started(startAt), ...Array.from({ length: 10 }, (_, i) => seg(400 + i * 20)), ended(reason)],
  closeAfter: true,
});

const extractRequests = (requests: LlmRequest[]) => requests.filter((r) => r.user.includes("## new lines"));
const section = (user: string, name: string) => user.split(`## ${name}`)[1]?.split("\n## ")[0] ?? "";

test("a gap is transcribed, extracted and marked filled; claims inside it are deduped against claims around it", async () => {
  await inRollback(async (tx) => {
    const { s, gap } = await stoppedWithGap(tx, { name: false });
    await extracted(tx, s.id, 1200, [
      { claim: "far early", t0: 10 },
      { claim: "near before", t0: 380 },
      { claim: "near after", t0: 620 },
      { claim: "far late", t0: 1150 },
    ]);
    const speech = scriptedSpeech([gapScript()]);
    const hub = createHub(100);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const llm = fakeLlm(NO_CLAIMS);

    expect(await fillGaps({ db: tx, hub, llm: llm.client, summarize: noSummary, runner }, s.id)).toBe(1);

    expect(speech.starts[0]).toMatchObject({
      session_id: `${s.id}-g${gap.id}`, url: URL, start_at: 400, stop_at: 600, registry_from: s.id, record: false, speaker_floor: 1,
    });
    expect(await gaps.open(tx, s.id)).toEqual([]);
    const inside = (await segments.list(tx, s.id, { from: 400, to: 599 })).map((x) => x.text);
    expect(inside).toEqual(Array.from({ length: 10 }, (_, i) => `g${400 + i * 20}`));
    const { rows: legRows } = await tx.query("select kind, speech_id, start_t, end_reason from session_legs where session_id = $1", [s.id]);
    expect(legRows).toEqual([{ kind: "gap", speech_id: `${s.id}-g${gap.id}`, start_t: 400, end_reason: "source_ended" }]);
    // The video itself is untouched: still stopped, its main cursor where it was.
    expect((await sessions.get(tx, s.id))?.status).toBe("stopped");
    expect(await calls.lastAnsweredWindow(tx, s.id, "extract")).toBe(1200);

    const asked = extractRequests(llm.requests);
    expect(asked.length).toBeGreaterThan(0);
    const fresh = asked.flatMap((r) => [...section(r.user, "new lines (extract from these)").matchAll(/ (g|w)(\d+)/g)].map((m) => `${m[1]}${m[2]}`));
    expect(fresh).toEqual(Array.from({ length: 10 }, (_, i) => `g${400 + i * 20}`));
    for (const r of asked) {
      const prior = section(r.user, "already extracted");
      expect(prior).toContain("near before");
      expect(prior).toContain("near after");
      expect(prior).not.toContain("far early");
      expect(prior).not.toContain("far late");
    }
    // Filled is final: the next run asks speech for nothing.
    expect(await fillGaps({ db: tx, hub, llm: llm.client, summarize: noSummary, runner }, s.id)).toBe(0);
    expect(speech.starts).toHaveLength(1);
  });
});

test("a gap leg that starts late is not marked filled, and after five failed legs the gap is given up with a note", async () => {
  await inRollback(async (tx) => {
    const { s, gap } = await stoppedWithGap(tx, { name: false });
    await extracted(tx, s.id, 1200, []);
    const speech = scriptedSpeech([gapScript(410), gapScript(400, "error"), { refuse: "busy" }, gapScript(412), gapScript(420)]);
    const hub = createHub(100);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const llm = fakeLlm(NO_CLAIMS);
    const deps = { db: tx, hub, llm: llm.client, summarize: noSummary, runner };

    expect(await fillGaps(deps, s.id)).toBe(0);
    expect((await gaps.open(tx, s.id)).map((g) => g.id)).toEqual([gap.id]);
    expect(extractRequests(llm.requests)).toHaveLength(0);
    const { rows } = await tx.query("select end_reason, ended_at is not null as ended from session_legs where session_id = $1", [s.id]);
    expect(rows).toEqual([{ end_reason: "source_ended", ended: true }]);

    for (let i = 0; i < 4; i++) expect(await fillGaps(deps, s.id)).toBe(0);
    expect(speech.starts).toHaveLength(5);
    const [left] = await gaps.open(tx, s.id);
    expect(left?.note).toMatch(/5/);
    // Given up: no sixth leg.
    expect(await fillGaps(deps, s.id)).toBe(0);
    expect(speech.connections).toHaveLength(5);
  });
});

test("a gap leg never opens while the video has a main leg", async () => {
  await inRollback(async (tx) => {
    const { s, gap } = await stoppedWithGap(tx);
    const speech = scriptedSpeech([{ events: [started(1200)] }]);
    const runner = createSessionRunner({ db: tx, hub: createHub(100), connect: speech.connector });
    await runner.resume(s.id);
    expect(await runner.fillGap(s.id, gap)).toBe(false);
    expect(speech.starts.map((x) => x.session_id)).toEqual([s.id]);
    await runner.stop(s.id);
  });
});

test("the summary of a talk overlapping the gap is written again", async () => {
  await inRollback(async (tx) => {
    const stage = await stages.create(tx, { conference: "Summit", name: "Main", day: "2026-11-16", description: "" });
    const mk = (title: string) => talks.create(tx, stage.id, { title, description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [] });
    const [a, b, c] = [await mk("A"), await mk("B"), await mk("C")];
    const { s } = await stoppedWithGap(tx, { name: false }, stage.id);
    await extracted(tx, s.id, 1200, []);
    const span = (talkId: number, t: number) => spans.switchTo(tx, s.id, { talkId, state: "talk", t, confidence: 0.9, quote: null, source: "tracker", callId: null });
    await span(a.id, 0);
    await span(b.id, 500);
    await span(c.id, 800);
    await spans.close(tx, s.id, 1200);
    const asked: [string, number, unknown][] = [];
    const summarize = async (sessionId: string, talkId: number, opts?: unknown) => { asked.push([sessionId, talkId, opts]); return null; };
    const unsure = JSON.stringify({ state: "unknown", talk_id: null, confidence: 0.2, quote: "" });
    const llm = fakeLlm((r: LlmRequest) => (r.user.includes("## current belief") ? unsure : NO_CLAIMS));
    const speech = scriptedSpeech([gapScript()]);
    const runner = createSessionRunner({ db: tx, hub: createHub(100), connect: speech.connector });

    expect(await fillGaps({ db: tx, hub: createHub(100), llm: llm.client, summarize, runner }, s.id)).toBe(1);
    expect(asked).toEqual([[s.id, a.id, { force: false }], [s.id, b.id, { force: false }]]);
  });
});

test("a sweep fills the gaps of a stopped video whose own extraction is done", async () => {
  await inRollback(async (tx) => {
    const { s } = await stoppedWithGap(tx, { name: false });
    await extracted(tx, s.id, 1205, []);
    const speech = scriptedSpeech([gapScript()]);
    const hub = createHub(100);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const report = await createSweeper({ db: tx, hub, llm: fakeLlm(NO_CLAIMS).client, summarize: noSummary, runner }).sweep();
    expect(report.filled).toContain(s.id);
    expect(await gaps.open(tx, s.id)).toEqual([]);
    // The gap's lines sit below the main cursor: the video owes the main extractor nothing afterwards.
    expect(report.extracted).not.toContain(s.id);
    expect(await calls.lastAnsweredWindow(tx, s.id, "extract")).toBe(1205);
  });
});

test("a gap at the end whose extraction failed is read once, left to the filler, and never extracted twice", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { name: false } });
    await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 385 });
    for (let t = 0; t < 400; t += 20) await say(tx, s.id, t);
    await sessions.setStatus(tx, s.id, "stopped");
    await gaps.add(tx, s.id, 400, 600);
    await extracted(tx, s.id, 385, []);
    const speech = scriptedSpeech([gapScript()]);
    const hub = createHub(100);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });

    const down = fakeLlm(new Error("proxy down"));
    const first = await createSweeper({ db: tx, hub, llm: down.client, summarize: noSummary, runner }).sweep();
    expect(first.filled).toEqual([]);
    expect((await segments.list(tx, s.id, { from: 400, to: 599 }))).toHaveLength(10);
    expect(await calls.lastAnsweredWindow(tx, s.id, "extract")).toBe(385);

    const up = fakeLlm(NO_CLAIMS);
    const second = await createSweeper({ db: tx, hub, llm: up.client, summarize: noSummary, runner }).sweep();
    // The video's own extractor never took the gap's lines: only the filler did, once each, and speech was asked once.
    expect(second.extracted).not.toContain(s.id);
    expect(second.filled).toContain(s.id);
    expect(speech.starts).toHaveLength(1);
    const fresh = extractRequests(up.requests).flatMap((r) => [...section(r.user, "new lines (extract from these)").matchAll(/ g(\d+)/g)].map((m) => Number(m[1])));
    expect(fresh).toEqual(Array.from({ length: 10 }, (_, i) => 400 + i * 20));
    expect(await calls.lastAnsweredWindow(tx, s.id, "extract")).toBe(585);
  });
});
