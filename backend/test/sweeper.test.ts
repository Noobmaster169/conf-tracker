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
/** `busy`: live or settling; `pending`: settling only (a final loop run or a hold), a subset of busy. */
const runnerOf = (busy: string[] = [], pending: string[] = [], wanted: (id: string) => boolean = () => false): SessionRunner => ({
  start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")),
  resumeAll: () => Promise.resolve([]), live: () => busy, busy: () => [...new Set([...busy, ...pending])], hold: () => {}, fillGap: () => Promise.resolve(false),
  pending: () => pending, wanted,
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
    // Inside the back-off the failed video is left alone.
    expect((await createSweeper({ db: tx, hub: createHub(10), llm: up.client, summarize: noSummary, runner: runnerOf() }).sweep()).extracted).not.toContain(s.id);
    expect(up.requests.filter((r) => r.user.includes("w0"))).toHaveLength(0);
    const later = () => Date.now() + 16 * 60 * 1000;
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: up.client, summarize: noSummary, runner: runnerOf(), now: later }).sweep();
    expect(report.extracted).toContain(s.id);
    expect(await answered(tx, s.id)).toBeGreaterThanOrEqual(391);
    // No window skipped: the lines the model was shown as new, in order, cover every line once.
    const seen = up.requests.filter((r) => r.user.includes("## new lines")).flatMap((r) => {
      const fresh = r.user.split("## new lines (extract from these)\n")[1] ?? "";
      return [...fresh.matchAll(/ w(\d+)/g)].map((m) => Number(m[1]));
    });
    const mine = seen.filter((n) => n % 10 === 0 && n < 400);
    expect(mine.slice(0, 40)).toEqual(Array.from({ length: 40 }, (_, i) => i * 10));
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

test("a closed talk without a summary gets one, a live video's included; a talk with one is left alone; a settling video's talk waits", async () => {
  await inRollback(async (tx) => {
    const stage = await stages.create(tx, { conference: "Summit", name: "Main", day: "2026-10-06", description: "" });
    const mk = (title: string) => talks.create(tx, stage.id, { title, description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [] });
    const [a, b, c] = [await mk("A"), await mk("B"), await mk("C")];
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract: false } });
    const busy = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract: false } });
    const live = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract: false } });
    const span = (sid: string, talkId: number, t: number) => spans.switchTo(tx, sid, { talkId, state: "talk", t, confidence: 0.9, quote: null, source: "tracker", callId: null });
    await span(s.id, a.id, 0);
    await span(s.id, b.id, 100);
    await span(s.id, c.id, 200); // c is still running, not closed
    await span(busy.id, a.id, 0);
    await spans.close(tx, busy.id, 50);
    // A live video's first talk ended (the next began): its summary need not wait for the video to stop.
    await span(live.id, a.id, 0);
    await span(live.id, c.id, 60);
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
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize, runner: runnerOf([live.id], [busy.id]) }).sweep();
    expect(asked.filter(([sid]) => sid === s.id || sid === busy.id || sid === live.id).sort()).toEqual([[s.id, a.id], [live.id, a.id]].sort());
    expect(report.summarised).not.toContain(b.id);
  });
});

test("a sweep that fails reports nothing instead of throwing, and a sweep never overlaps the one running", async () => {
  await inRollback(async (tx) => {
    const broken = { query: () => Promise.reject(new Error("db gone")) } as unknown as typeof tx;
    const failing = createSweeper({ db: broken, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize: noSummary, runner: runnerOf() });
    expect(await failing.sweep()).toEqual({ extracted: [], summarised: [], gaps: [] });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let queries = 0;
    const slow = { query: async (...args: unknown[]) => { queries += 1; await gate; return (tx.query as (...a: unknown[]) => unknown)(...args); } } as unknown as typeof tx;
    const sweeper = createSweeper({ db: slow, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize: noSummary, runner: runnerOf() });
    const first = sweeper.sweep();
    expect(await sweeper.sweep()).toEqual({ extracted: [], summarised: [], gaps: [] });
    expect(queries).toBe(1);
    release();
    await first;
  });
});

test("a finished video drops out: nothing is asked and nothing is reported once its cursor reaches its last line", async () => {
  await inRollback(async (tx) => {
    const s = await backlog(tx);
    const first = fakeLlm(NO_CLAIMS);
    await createSweeper({ db: tx, hub: createHub(10), llm: first.client, summarize: noSummary, runner: runnerOf() }).sweep();
    const again = fakeLlm(NO_CLAIMS);
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: again.client, summarize: noSummary, runner: runnerOf() }).sweep();
    expect(report.extracted).not.toContain(s.id);
    expect(again.requests.filter((r) => r.user.includes("w390"))).toHaveLength(0);
  });
});

test("a summary that failed is asked again at most once an hour, and never after five failures", async () => {
  await inRollback(async (tx) => {
    const stage = await stages.create(tx, { conference: "Summit", name: "Main", day: "2026-10-06", description: "" });
    const talk = await talks.create(tx, stage.id, { title: "A", description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [] });
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract: false } });
    await spans.switchTo(tx, s.id, { talkId: talk.id, state: "talk", t: 0, confidence: 0.9, quote: null, source: "tracker", callId: null });
    await spans.close(tx, s.id, 100);
    const failed = () => calls.insert(tx, s.id, {
      step: "summarize", promptVersion: "v1", model: "m", windowT0: 0, windowT1: 1, attempt: 1, input: "x", output: null, parsed: null,
      inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: "proxy down", talkId: talk.id,
    });
    await failed();
    let asked = 0;
    const summarize = async (sid: string) => { if (sid === s.id) asked += 1; return null; };
    const at = (min: number) => () => Date.now() + min * 60 * 1000;
    const sweep = (min: number) => createSweeper({ db: tx, hub: createHub(10), llm: fakeLlm(NO_CLAIMS).client, summarize, runner: runnerOf(), now: at(min) }).sweep();
    await sweep(5);
    expect(asked).toBe(0);
    await sweep(61);
    expect(asked).toBe(1);
    for (let i = 0; i < 4; i++) await failed();
    await sweep(500);
    expect(asked).toBe(1);
  });
});

test("a sweep's drain of a backlog yields before its next window while the runner wants the video back", async () => {
  await inRollback(async (tx) => {
    const s = await backlog(tx);
    const llm = fakeLlm(NO_CLAIMS);
    // Wanted from the first window on (a resume waiting since the drain began): not one window is asked.
    const report = await createSweeper({ db: tx, hub: createHub(10), llm: llm.client, summarize: noSummary, runner: runnerOf([], [], (id) => id === s.id) }).sweep();
    expect(report.extracted).not.toContain(s.id);
    expect(await answered(tx, s.id)).toBe(0);
  });
});
