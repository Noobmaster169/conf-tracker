import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { ExtractConfig } from "../src/contracts";
import { closePool } from "../src/db";
import { createHub } from "../src/realtime/hub";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createSweeper } from "../src/ingest/sweeper";
import * as calls from "../src/repositories/calls";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as stages from "../src/repositories/stages";
import * as summaries from "../src/repositories/summaries";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const NO_CLAIMS = JSON.stringify({ claims: [] });
const runnerOf = (busy: string[] = []): SessionRunner => ({
  start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")),
  resumeAll: () => Promise.resolve([]), live: () => busy, busy: () => busy,
});
const say = (db: Parameters<typeof segments.insert>[0], sessionId: string, t0: number) =>
  segments.insert(db, sessionId, { t0, t1: t0 + 5, text: `w${t0}`, words: [{ w: `w${t0}`, t0, t1: t0 + 1, p: 1, speaker_id: "S1" }] });
const answered = async (db: Parameters<typeof calls.latest>[0], id: string) => calls.lastAnsweredWindow(db, id, "extract");
const noSummary = async () => null;

async function backlog(tx: Parameters<typeof segments.insert>[0], config: Record<string, unknown> = {}) {
  const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config });
  for (let t = 0; t < 400; t += 10) await say(tx, s.id, t);
  return s;
}

test("a stopped video with a backlog is extracted to its end", async () => {
  await inRollback(async (tx) => {
    const s = await backlog(tx);
    const llm = fakeLlm(NO_CLAIMS);
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: llm.client, summarize: noSummary, runner: runnerOf() }).sweep();
    expect(report.extracted).toContain(s.id);
    expect(await answered(tx, s.id)).toBeGreaterThanOrEqual(391);
  });
});

test("with the model failing nothing moves and the next sweep (model back) finishes it", async () => {
  await inRollback(async (tx) => {
    const s = await backlog(tx);
    const down = fakeLlm(new Error("proxy down"));
    await createSweeper({ db: tx, hub: createHub(10), llm: down.client, summarize: noSummary, runner: runnerOf() }).sweep();
    expect(await answered(tx, s.id)).toBe(0);
    const up = fakeLlm(NO_CLAIMS);
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: up.client, summarize: noSummary, runner: runnerOf() }).sweep();
    expect(report.extracted).toContain(s.id);
    expect(await answered(tx, s.id)).toBeGreaterThanOrEqual(391);
  });
});

test("a running video, or one still flushing, is left to its own extractor", async () => {
  await inRollback(async (tx) => {
    const s = await backlog(tx);
    const llm = fakeLlm(NO_CLAIMS);
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: llm.client, summarize: noSummary, runner: runnerOf([s.id]) }).sweep();
    expect(report.extracted).not.toContain(s.id);
    expect(await answered(tx, s.id)).toBe(0);
  });
});

test("a video that does not extract, or is older than a week, is skipped", async () => {
  await inRollback(async (tx) => {
    const off = await backlog(tx, { extract: false });
    const old = await backlog(tx);
    await tx.query(`update sessions set created_at = now() - interval '8 days' where id = $1`, [old.id]);
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize: noSummary, runner: runnerOf() }).sweep();
    expect(report.extracted).not.toContain(off.id);
    expect(report.extracted).not.toContain(old.id);
    expect(ExtractConfig.parse({ extract: false }).extract).toBe(false);
  });
});

test("a closed talk without a summary gets one; a talk with one is left alone; a busy video's talk waits", async () => {
  await inRollback(async (tx) => {
    const stage = await stages.create(tx, { conference: "Summit", name: "Main", day: "2026-10-06", description: "" });
    const mk = (title: string) => talks.create(tx, stage.id, { title, description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [] });
    const [a, b, c] = [await mk("A"), await mk("B"), await mk("C")];
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract: false } });
    const busy = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract: false } });
    const span = (sid: string, talkId: number, t: number) => spans.switchTo(tx, sid, { talkId, state: "talk", t, confidence: 0.9, quote: null, source: "tracker", callId: null });
    await span(s.id, a.id, 0);
    await span(s.id, b.id, 100);
    await span(s.id, c.id, 200); // c is still running, not closed
    await span(busy.id, a.id, 0);
    await spans.close(tx, busy.id, 50);
    await spans.close(tx, s.id, 300).then(() => undefined);
    // Re-open c: only a and b are closed talks for this video.
    await tx.query(`update talk_spans set t1 = null where session_id = $1 and talk_id = $2`, [s.id, c.id]);
    const call = await calls.insert(tx, s.id, {
      step: "extract", promptVersion: "v1", model: "m", windowT0: 0, windowT1: 1, attempt: 1, input: "x", output: null, parsed: null,
      inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: null,
    });
    await summaries.insert(tx, { talkId: b.id, sessionId: s.id, callId: call.id, summary: { headline: "h", content: "c" } });

    const asked: [string, number][] = [];
    const summarize = async (sessionId: string, talkId: number) => { asked.push([sessionId, talkId]); return null; };
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize, runner: runnerOf([busy.id]) }).sweep();
    expect(asked.filter(([sid]) => sid === s.id || sid === busy.id)).toEqual([[s.id, a.id]]);
    expect(report.summarised).not.toContain(b.id);
  });
});

test("a sweep that fails reports nothing instead of throwing, and a sweep never overlaps the one running", async () => {
  await inRollback(async (tx) => {
    const broken = { query: () => Promise.reject(new Error("db gone")) } as unknown as typeof tx;
    const failing = createSweeper({ db: broken, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize: noSummary, runner: runnerOf() });
    expect(await failing.sweep()).toEqual({ extracted: [], summarised: [] });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let queries = 0;
    const slow = { query: async (...args: unknown[]) => { queries += 1; await gate; return (tx.query as (...a: unknown[]) => unknown)(...args); } } as unknown as typeof tx;
    const sweeper = createSweeper({ db: slow, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize: noSummary, runner: runnerOf() });
    const first = sweeper.sweep();
    expect(await sweeper.sweep()).toEqual({ extracted: [], summarised: [] });
    expect(queries).toBe(1);
    release();
    await first;
  });
});
