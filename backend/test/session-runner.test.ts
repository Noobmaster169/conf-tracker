import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { afterAll, expect, test } from "vitest";

import type { LiveEvent, SpeechEvent } from "../src/contracts";
import { closePool, type Queryable } from "../src/db";
import { fakeSpeech, scriptedSpeech } from "../src/ingest/__fakes__/fake-speech";
import type { Extractor, ExtractorFactory } from "../src/ingest/extractor";
import { createLoop } from "../src/ingest/loop";
import { createSessionRunner } from "../src/ingest/session-runner";
import { TerminalError } from "../src/lib/errors";
import { createHub } from "../src/realtime/hub";
import * as callsRepo from "../src/repositories/calls";
import * as events from "../src/repositories/events";
import * as gaps from "../src/repositories/gaps";
import * as legs from "../src/repositories/legs";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as speakersRepo from "../src/repositories/speakers";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";

const started: SpeechEvent = {
  type: "session.started",
  session_id: "x",
  started_at: "2026-09-23T10:00:00.000Z",
  source: { url: URL },
  models: { asr: "large-v3" },
  config: {},
  start_at: 0,
  broadcast_start: null,
};
const segment: SpeechEvent = { type: "asr.segment", t0: 0, t1: 1.2, text: "hello", words: [{ w: "hello", t0: 0, t1: 1.2, p: 0.9 }] };
const health: SpeechEvent = { type: "health", t: 1.2, lag_s: 3, gpu_ms_asr: 500, gpu_ms_diar: 0, buffer_s: 0.5, behind_s: null };

test("a live session stores every event, the segment, and publishes in order", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    const speech = fakeSpeech([started, segment, health, { type: "session.ended", reason: "source_ended", message: "" }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { speed: 2 } });
    hub.subscribe(created.id, (e) => seen.push(e));

    await runner.start(created.id);
    await speech.done;

    expect(speech.starts[0]).toEqual({ session_id: created.id, url: URL, file: undefined, speed: 2, config: { speed: 2 }, start_at: 0, speaker_floor: 0, max_speed: 3 });
    expect(seen.map((e) => e.type)).toEqual(["session", "segment", "health", "session"]);
    expect((await events.list(tx, created.id)).map((e) => e.type)).toEqual(["session.started", "asr.segment", "health", "session.ended"]);
    const stored = await segments.list(tx, created.id, {});
    expect(stored[0]?.text).toBe("hello");
    expect(stored[0]?.words[0]?.speaker_id).toBeNull();
    const final = await sessions.get(tx, created.id);
    expect(final?.status).toBe("stopped");
    expect(final?.models).toEqual({ asr: "large-v3" });
    expect(hub.latest(created.id, "health")?.data).toMatchObject({ t: 1.2, lag_s: 3 });
    expect(runner.live()).toEqual([]);
  });
});

test("a leg that speech ends with an error leaves the video recovering, with a retry scheduled", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = fakeSpeech([started, { type: "session.ended", reason: "error", message: "yt-dlp failed" }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });

    await runner.start(created.id);
    await speech.done;
    await until(() => clock.pending() === 1, "a retry");

    const final = await sessions.get(tx, created.id);
    expect(final?.status).toBe("recovering");
    expect(final?.recovering_since).not.toBeNull();
    expect(final?.stopped_at).toBeNull();
    expect(runner.live()).toEqual([created.id]);
    expect((await legs.latest(tx, created.id))?.end_reason).toBe("error");
    await runner.stop(created.id);
  });
});

test("marks the session recovering when speech closes unexpectedly", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect(runner.live()).toEqual([created.id]);

    await speech.drop("socket reset");
    expect((await sessions.get(tx, created.id))?.status).toBe("recovering");
    expect(clock.delays()).toEqual([5]);
    expect(runner.live()).toEqual([created.id]);
    await runner.stop(created.id);
  });
});

test("stop closes the link and the session ends stopped, not degraded", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    const stopped = await runner.stop(created.id);
    expect(stopped.status).toBe("stopped");
    await speech.closed;
    expect((await sessions.get(tx, created.id))?.status).toBe("stopped");
  });
});

test("start fails loudly and marks degraded when speech is unreachable", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const runner = createSessionRunner({
      db: tx,
      hub,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await expect(runner.start(created.id)).rejects.toThrow(/ECONNREFUSED/);
    expect((await sessions.get(tx, created.id))?.status).toBe("degraded");
  });
});

test("start of an unknown session is a terminal error", async () => {
  await inRollback(async (tx) => {
    const runner = createSessionRunner({ db: tx, hub: createHub(10), connect: fakeSpeech([]).connector });
    await expect(runner.start("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/not found/);
  });
});

test("numbering resumes after the last stored event", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await events.append(tx, created.id, 1, "health", { t: 1 });
    await events.append(tx, created.id, 2, "health", { t: 2 });

    await runner.start(created.id);
    await speech.done;

    const stored = await events.list(tx, created.id);
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(stored[2]?.type).toBe("session.started");
  });
});

test("events after stop are ignored", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    await runner.stop(created.id);

    await speech.emit(segment);
    await speech.emit(started);

    expect((await sessions.get(tx, created.id))?.status).toBe("stopped");
    expect(await segments.list(tx, created.id, {})).toEqual([]);
    expect((await events.list(tx, created.id)).map((e) => e.type)).toEqual(["session.started"]);
  });
});

test("concurrent starts share one link", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });

    const first = runner.start(created.id);
    const second = runner.start(created.id);
    await Promise.all([first, second]);
    await speech.done;

    expect(speech.starts).toHaveLength(1);
    expect(runner.live()).toEqual([created.id]);
  });
});

const words = (...ws: [string, number, number][]) => ws.map(([w, t0, t1]) => ({ w, t0, t1, p: 0.9 }));
const diar = (t0: number, t1: number, turns: [number, number, string][], matches: string[] = []): SpeechEvent => ({
  type: "diar.turns",
  window: { t0, t1 },
  turns: turns.map(([a, b, speaker_id]) => ({ t0: a, t1: b, speaker_id })),
  matches: matches.map((id) => ({ local: `L${id}`, speech_s: 5, speaker_id: id, scores: {}, new: false })),
  gpu_ms: 1500,
});

test("a window that arrives after a segment re-assigns it and publishes segment.updated", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    const speech = fakeSpeech([
      started,
      { type: "asr.segment", t0: 1, t1: 3, text: "hello there", words: words(["hello", 1, 2], ["there", 2, 3]) },
      { type: "speaker.new", speaker_id: "S1", first_seen_t: 0.5 },
      diar(0, 10, [[0.5, 2, "S1"]], ["S1"]),
    ], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    hub.subscribe(created.id, (e) => seen.push(e));
    await runner.start(created.id);
    await speech.done;

    expect(seen.map((e) => e.type)).toEqual(["session", "segment", "speaker", "segment.updated", "speaker", "turns"]);
    const [stored] = await segments.list(tx, created.id, {});
    expect(stored?.words.map((w) => w.speaker_id)).toEqual(["S1", null]);
    expect(await speakersRepo.get(tx, created.id, "S1")).toMatchObject({ first_seen_t: 0.5, last_seen_t: 2, talk_s: 1.5 });
    const turnsEvent = seen.at(-1);
    expect(turnsEvent?.type === "turns" && turnsEvent.data.turns).toEqual([{ t0: 0.5, t1: 2, speaker_id: "S1" }]);
  });
});

test("a segment arriving after a window is labelled on insert", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([
      started,
      { type: "speaker.new", speaker_id: "S1", first_seen_t: 0 },
      diar(0, 10, [[0, 10, "S1"]], ["S1"]),
      { type: "asr.segment", t0: 4, t1: 5, text: "late", words: words(["late", 4, 5]) },
    ], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    const [stored] = await segments.list(tx, created.id, {});
    expect(stored?.words[0]?.speaker_id).toBe("S1");
  });
});

test("speaker.merged marks the row and later assignments use the survivor", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([
      started,
      { type: "speaker.new", speaker_id: "S1", first_seen_t: 0 },
      { type: "speaker.new", speaker_id: "S2", first_seen_t: 5 },
      diar(0, 10, [[0, 5, "S1"], [5, 10, "S2"]], ["S1", "S2"]),
      { type: "speaker.merged", speaker_id: "S2", into: "S1", score: 0.8 },
      { type: "asr.segment", t0: 6, t1: 7, text: "after", words: words(["after", 6, 7]) },
    ], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    expect((await speakersRepo.get(tx, created.id, "S2"))?.merged_into).toBe("S1");
    expect((await speakersRepo.get(tx, created.id, "S1"))?.talk_s).toBe(10);
    const [stored] = await segments.list(tx, created.id, {});
    expect(stored?.words[0]?.speaker_id).toBe("S1");
  });
});

function fakeExtractors() {
  const log: string[] = [];
  const configs: Record<string, unknown>[] = [];
  const factory: ExtractorFactory = ({ sessionId, config }) => {
    configs.push(config);
    const extractor: Extractor = {
      tick: async () => void log.push(`tick ${sessionId}`),
      flush: async () => void log.push(`flush ${sessionId}`),
      advance: (t) => void log.push(`advance ${sessionId} ${t}`),
      cancelQueued: () => void log.push(`cancel ${sessionId}`),
      stop: () => void log.push(`stop ${sessionId}`),
      drain: async () => true,
    };
    return extractor;
  };
  return { factory, log, configs };
}

test("the extractor comes up with the link, and stop drops its queue, flushes it once, then stops it", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const extractors = fakeExtractors();
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [extractors.factory] });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract_model: "haiku" } });
    await runner.start(created.id);
    await speech.done;
    expect(extractors.configs).toEqual([{ extract_model: "haiku" }]);
    expect(extractors.log).toEqual([]);
    await runner.stop(created.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(extractors.log).toEqual([`cancel ${created.id}`, `flush ${created.id}`, `stop ${created.id}`]);
  });
});

test("a session speech ends, or drops, flushes and stops the extractor too", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const ended = fakeSpeech([started, { type: "session.ended", reason: "source_ended", message: "" }]);
    const extractors = fakeExtractors();
    const runner = createSessionRunner({ db: tx, hub, connect: ended.connector, loops: [extractors.factory] });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await ended.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(extractors.log).toEqual([`flush ${created.id}`, `stop ${created.id}`]);
  });
});

test("a stored segment advances each loop to its end time", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started, segment], { closeAfter: false });
    const extractors = fakeExtractors();
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [extractors.factory] });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    expect(extractors.log).toEqual([`advance ${created.id} 1.2`]);
  });
});

test("a stop with several runs queued makes only the one in flight and the final pass", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    // One segment far into the stream, as a max-speed replay delivers them: boundaries 30..180 all queue at once.
    const late: SpeechEvent = { type: "asr.segment", t0: 199, t1: 200, text: "late", words: [{ w: "late", t0: 199, t1: 200, p: 0.9 }] };
    const speech = fakeSpeech([started, late], { closeAfter: false });
    const runs: number[] = [];
    let finish: () => void = () => {};
    const factory = () =>
      createLoop(
        (upTo) => {
          runs.push(upTo);
          return upTo === 30 ? new Promise<void>((resolve) => (finish = resolve)) : Promise.resolve();
        },
        { intervalS: 30, finalRun: true },
      );
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [factory] });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toEqual([30]);
    await runner.stop(created.id);
    finish();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toEqual([30, Number.POSITIVE_INFINITY]);
  });
});

test("a factory that refuses the config fails the start before any socket opens", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({
      db: tx,
      hub,
      connect: speech.connector,
      loops: [
        () => {
          throw new TerminalError("no prompt extract/v99");
        },
      ],
    });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { extract_prompt: "v99" } });
    await expect(runner.start(created.id)).rejects.toThrow(/v99/);
    expect(speech.starts).toHaveLength(0);
    expect((await sessions.get(tx, created.id))?.status).toBe("degraded");
  });
});

test("every loop comes up with the link, and a stop flushes and stops each", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const first = fakeExtractors();
    const second = fakeExtractors();
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [first.factory, () => null, second.factory] });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    await runner.stop(created.id);
    await new Promise((resolve) => setImmediate(resolve));
    for (const loop of [first, second]) expect(loop.log).toEqual([`cancel ${created.id}`, `flush ${created.id}`, `stop ${created.id}`]);
  });
});

test("a merge carries the absorbed speaker's name to the survivor and publishes it", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    hub.subscribe(created.id, (e) => seen.push(e));
    const call = await callsRepo.insert(tx, created.id, {
      step: "name", promptVersion: "v1", model: "haiku", windowT0: 0, windowT1: 10, attempt: 1, input: "x", output: null, parsed: null,
      inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: null,
    });
    await speakersRepo.upsert(tx, created.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 5 });
    await speakersRepo.upsert(tx, created.id, { speakerId: "S2", firstSeenT: 6, lastSeenT: 9 });
    await speakersRepo.setName(tx, created.id, "S2", { name: "Cathie Wood", role: null, confidence: 0.9, quote: "I'm Cathie Wood", callId: call.id });
    const speech = fakeSpeech([started, { type: "speaker.merged", speaker_id: "S2", into: "S1", score: 0.8 }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    await runner.start(created.id);
    await speech.done;
    expect((await speakersRepo.get(tx, created.id, "S1"))?.name).toBe("Cathie Wood");
    const survivor = seen.flatMap((e) => (e.type === "speaker" && e.data.speaker_id === "S1" ? [e.data] : [])).at(-1);
    expect(survivor).toMatchObject({ name: "Cathie Wood" });
  });
});

// --- Legs: a video survives its speech leg dying -------------------------------------------------------------------

/** Injected clock and timers: a timer runs only when the test fires it, and firing moves the clock by its delay. */
function fakeClock(startMs = Date.UTC(2026, 10, 16, 9, 0)) {
  let t = startMs;
  const timers: { fn: () => void; ms: number; cancelled: boolean; fired: boolean }[] = [];
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
    /** Every delay asked for, in seconds, cancelled ones included. */
    delays: () => timers.map((x) => x.ms / 1000),
    pending: () => timers.filter((x) => !x.cancelled && !x.fired).length,
    fireNext() {
      const timer = timers.find((x) => !x.cancelled && !x.fired);
      if (!timer) throw new Error("no timer pending");
      timer.fired = true;
      t += timer.ms;
      timer.fn();
    },
    /** Runs the last timer even if it was cancelled: a cancel that lost the race with the timer firing. */
    fireLastAnyway() {
      const timer = timers.at(-1)!;
      timer.fired = true;
      timer.fn();
    },
  };
}

async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The ith connection to a scripted speech, once it was made: a resume opens its leg in the background. */
async function conn(speech: { connections: unknown[] }, i: number) {
  await until(() => speech.connections.length > i, `connection ${i + 1}`);
  return (speech as ReturnType<typeof scriptedSpeech>).connections[i]!;
}

/** Lets queued handlers and their queries finish (the rollback client answers in well under this). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const seg = (t0: number, t1: number, text = `at ${t0}`): SpeechEvent => ({ type: "asr.segment", t0, t1, text, words: [{ w: text, t0, t1, p: 0.9 }] });
const startedAt = (start_at: number): SpeechEvent => ({ ...started, start_at } as SpeechEvent);
const endedWith = (reason: "error" | "source_ended" | "stopped", message = ""): SpeechEvent => ({ type: "session.ended", reason, message });
const legRows = async (tx: { query: PoolClient["query"] }, id: string) =>
  (await tx.query("select requested_t, start_t, end_reason from session_legs where session_id = $1 order by id", [id])).rows;

test("a dropped leg reopens from the resume point on the same video, with start_at, and the stored transcript has no duplicate", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([
      {
        events: [
          started,
          { type: "speaker.new", speaker_id: "S1", first_seen_t: 0 },
          seg(0, 1.2),
          seg(1.5, 3),
          diar(0, 3, [[0, 3, "S1"]], ["S1"]),
          seg(3.5, 5),
        ],
      },
      { events: [startedAt(3), seg(3.5, 5), seg(5.5, 6)] },
    ]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;

    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry");
    expect((await sessions.get(tx, created.id))?.status).toBe("recovering");
    expect(clock.delays()).toEqual([5]);
    expect(runner.live()).toEqual([created.id]);

    clock.fireNext();
    await until(() => speech.connections.length === 2, "the second leg");
    await (await conn(speech, 1)).done;

    expect(speech.starts[1]).toMatchObject({ session_id: created.id, url: URL, start_at: 3, speaker_floor: 1, max_speed: 3 });
    expect((await segments.list(tx, created.id, {})).map((s) => s.t0)).toEqual([0, 1.5, 3.5, 5.5]);
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect(await legRows(tx, created.id)).toEqual([
      { requested_t: 0, start_t: 0, end_reason: "error" },
      { requested_t: 3, start_t: 3, end_reason: null },
    ]);
    expect(runner.live()).toEqual([created.id]);
    await runner.stop(created.id);
  });
});

test("a refused start (already running) is retried with backoff and the third attempt opens", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { catchup_max_speed: 2 } });
    await sessions.setStatus(tx, created.id, "degraded");
    const refused = endedWith("error", `session ${created.id} is already running`);
    const speech = scriptedSpeech([
      { events: [refused], closeAfter: true },
      { refuse: "ECONNREFUSED" },
      { events: [started] },
      { events: [started] },
    ]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });

    await runner.resume(created.id);
    await until(() => clock.pending() === 1, "the first retry");
    expect((await sessions.get(tx, created.id))?.status).toBe("recovering");
    clock.fireNext();
    await until(() => clock.pending() === 1 && speech.connections.length === 2, "the second retry");
    clock.fireNext();
    await until(() => speech.connections.length === 3, "the third attempt");
    await (await conn(speech, 2)).done;

    expect(clock.delays()).toEqual([5, 10]);
    expect(speech.starts).toHaveLength(3);
    expect(speech.starts.every((s) => s.session_id === created.id && s.max_speed === 2)).toBe(true);
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect(clock.pending()).toBe(0);

    // A started leg resets the backoff.
    await (await conn(speech, 2)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry after the reset");
    expect(clock.delays()).toEqual([5, 10, 5]);
    await runner.stop(created.id);
  });
});

test("after 15 minutes recovering the video shows attention and still retries; a successful start clears it", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock(Date.UTC(2026, 10, 16, 9, 30));
    const speech = scriptedSpeech([{ refuse: "ECONNREFUSED" }, { refuse: "speech unreachable" }, { events: [started] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, created.id, "degraded");

    await runner.resume(created.id);
    await until(() => clock.pending() === 1, "the first retry");
    expect((await sessions.get(tx, created.id))?.attention).toBeNull();

    clock.advance(15 * 60 * 1000);
    clock.fireNext();
    await until(() => clock.pending() === 1 && speech.connections.length === 2, "the second retry");
    const waiting = await sessions.get(tx, created.id);
    expect(waiting?.status).toBe("recovering");
    expect(waiting?.attention).toBe("recovering since 09:30 UTC: speech unreachable");

    clock.fireNext();
    await until(() => speech.connections.length === 3, "the third attempt");
    await (await conn(speech, 2)).done;
    const back = await sessions.get(tx, created.id);
    expect(back?.status).toBe("live");
    expect(back?.attention).toBeNull();
    await runner.stop(created.id);
  });
});

test("stop during a scheduled retry: nothing opens afterwards and the video is stopped", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [started] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry");

    await runner.stop(created.id);
    expect(clock.pending()).toBe(0);
    clock.fireLastAnyway();
    await settle();

    expect(speech.connections).toHaveLength(1);
    expect((await sessions.get(tx, created.id))?.status).toBe("stopped");
    expect(runner.live()).toEqual([]);
  });
});

test("stop while a leg is still opening: the late link is closed and the video stays stopped", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const speech = scriptedSpeech([{ events: [started], gate }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, created.id, "degraded");

    const resuming = runner.resume(created.id);
    await until(() => speech.connections.length === 1, "the open");
    await runner.stop(created.id);
    open();
    await resuming;
    await (await conn(speech, 0)).closed;
    await settle();

    expect((await sessions.get(tx, created.id))?.status).toBe("stopped");
    expect(clock.pending()).toBe(0);
    expect(runner.live()).toEqual([]);
    expect(await events.list(tx, created.id)).toEqual([]);
  });
});

test("a leg that starts later than asked records a gap from the resume point to where it started", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [startedAt(42)] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await segments.insert(tx, created.id, { t0: 0, t1: 10, text: "before", words: [{ w: "before", t0: 0, t1: 10, p: 0.9, speaker_id: null }] });
    await sessions.setStatus(tx, created.id, "degraded");

    await runner.resume(created.id);
    await (await conn(speech, 0)).done;

    expect(speech.starts[0]).toMatchObject({ start_at: 10 });
    expect((await gaps.open(tx, created.id)).map((g) => [g.t0, g.t1])).toEqual([[10, 42]]);
    expect(await legRows(tx, created.id)).toEqual([{ requested_t: 10, start_t: 42, end_reason: null }]);
    await runner.stop(created.id);
  });
});

test("start_at past the end: source_ended with no segments stops the video, no retry", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const extractors = fakeExtractors();
    const speech = scriptedSpeech([{ events: [startedAt(100), endedWith("source_ended")], closeAfter: true }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [extractors.factory], now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await segments.insert(tx, created.id, { t0: 90, t1: 100, text: "last", words: [{ w: "last", t0: 90, t1: 100, p: 0.9, speaker_id: null }] });
    await sessions.setStatus(tx, created.id, "stopped");

    await runner.resume(created.id);
    await (await conn(speech, 0)).done;
    await settle();

    expect((await sessions.get(tx, created.id))?.status).toBe("stopped");
    expect(clock.pending()).toBe(0);
    expect(runner.live()).toEqual([]);
    expect(speech.connections).toHaveLength(1);
    expect(extractors.log).toEqual([`flush ${created.id}`, `stop ${created.id}`]);
    expect(await legRows(tx, created.id)).toEqual([{ requested_t: 100, start_t: 100, end_reason: "source_ended" }]);
  });
});

test("the loops are not recreated when a leg reopens: one extractor across legs", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const extractors = fakeExtractors();
    const speech = scriptedSpeech([{ events: [started, seg(0, 1.2)] }, { events: [startedAt(1), seg(1.5, 2)] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [extractors.factory], now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry");
    clock.fireNext();
    await until(() => speech.connections.length === 2, "the second leg");
    await (await conn(speech, 1)).done;
    await runner.stop(created.id);
    await settle();

    expect(extractors.configs).toHaveLength(1);
    expect(extractors.log).toEqual([`advance ${created.id} 1.2`, `advance ${created.id} 2`, `cancel ${created.id}`, `flush ${created.id}`, `stop ${created.id}`]);
  });
});

test("concurrent resumes open one leg, and a close from a leg that is no longer current is ignored", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [started] }, { events: [started] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, created.id, "degraded");

    await Promise.all([runner.resume(created.id), runner.resume(created.id)]);
    await (await conn(speech, 0)).done;
    expect(speech.starts).toHaveLength(1);

    await (await conn(speech, 0)).emit(endedWith("error", "boom"));
    await until(() => clock.pending() === 1, "a retry");
    // The old socket then closes: still one retry, not two.
    await (await conn(speech, 0)).drop("close 1006");
    await settle();
    expect(clock.pending()).toBe(1);
    clock.fireNext();
    await until(() => speech.connections.length === 2, "the second leg");
    await (await conn(speech, 1)).done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    await runner.stop(created.id);
  });
});

test("resume refuses a video that is not degraded or stopped; resumeAll picks up the running rows", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [started] }, { events: [started] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const live = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const recovering = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.markStarted(tx, live.id, { startedAt: "2026-11-16T09:00:00.000Z", models: {} });
    await sessions.setRecovering(tx, recovering.id);
    const degraded = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, degraded.id, "degraded");
    const stopped = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, stopped.id, "stopped");
    await tx.query("update sessions set status = 'stopped' where status in ('starting', 'live', 'recovering') and id not in ($1, $2)", [live.id, recovering.id]);

    await expect(runner.resume(live.id)).rejects.toThrow(/degraded or stopped/);
    expect(speech.starts).toHaveLength(0);

    const ids = await runner.resumeAll();
    expect(ids.sort()).toEqual([live.id, recovering.id].sort());
    await until(() => speech.connections.length === 2, "two legs");
    await Promise.all(speech.connections.map((c) => c.done));
    expect(runner.live().sort()).toEqual([live.id, recovering.id].sort());
    expect((await sessions.get(tx, degraded.id))?.status).toBe("degraded");
    expect((await sessions.get(tx, stopped.id))?.status).toBe("stopped");
    await runner.stop(live.id);
    await runner.stop(recovering.id);
  });
});

test("resumeAll revives videos concurrently: a connect that never answers does not hold the others", async () => {
  await inRollback(async (tx) => {
    const speech = scriptedSpeech([{ events: [started] }]);
    let calls = 0;
    const connect: typeof speech.connector = (...args) => {
      calls += 1;
      return calls === 1 ? new Promise(() => {}) : speech.connector(...args);
    };
    const runner = createSessionRunner({ db: tx, hub: createHub(100), connect, now: fakeClock().now, setTimer: fakeClock().setTimer });
    await tx.query("update sessions set status = 'stopped' where status in ('starting', 'live', 'recovering')");
    const a = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const b = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setRecovering(tx, a.id);
    await sessions.setRecovering(tx, b.id);
    void runner.resumeAll();
    await until(() => speech.connections.length === 1, "the second video's leg opens while the first connect hangs");
    expect(calls).toBe(2);
    // Its events are handled before the rollback, so nothing writes to a row that is gone.
    await (await conn(speech, 0)).done;
  });
});

// --- Fix round 1 ---------------------------------------------------------------------------------------------------

/** The rollback client, with a hook that may fail or hold a query before it reaches Postgres. */
function hookedDb(tx: PoolClient, hook: (text: string) => Promise<void> | void): Queryable {
  return {
    query: async <R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
      await hook(text);
      return tx.query<R>(text, values);
    },
  };
}

test("a database error while marking the video recovering still schedules the retry, and the next leg opens", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let failRecovering = false;
    const db = hookedDb(tx, (text) => {
      if (failRecovering && text.includes("status = 'recovering'")) {
        failRecovering = false;
        throw new Error("connection reset by peer");
      }
    });
    const speech = scriptedSpeech([{ events: [started] }, { events: [started] }]);
    const runner = createSessionRunner({ db, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;

    failRecovering = true;
    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry despite the failed write");
    clock.fireNext();
    await until(() => speech.connections.length === 2, "the second leg");
    await (await conn(speech, 1)).done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    await runner.stop(created.id);
  });
});

test("a database error while reopening a leg is one more failed attempt, not a degraded video", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let failResume = false;
    const db = hookedDb(tx, (text) => {
      if (failResume && text.includes("from diar_windows where session_id = $1) as win")) {
        failResume = false;
        throw new Error("too many connections");
      }
    });
    const speech = scriptedSpeech([{ events: [started] }, { events: [started] }]);
    const runner = createSessionRunner({ db, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry");

    failResume = true;
    clock.fireNext();
    await until(() => clock.pending() === 1 && clock.delays().length === 2, "a second retry");
    expect(clock.delays()).toEqual([5, 10]);
    expect((await sessions.get(tx, created.id))?.status).toBe("recovering");
    clock.fireNext();
    await until(() => speech.connections.length === 2, "the second leg");
    await (await conn(speech, 1)).done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    await runner.stop(created.id);
  });
});

test("a voice heard in two legs keeps its talk time, and the video keeps its first start time", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([
      { events: [started, { type: "speaker.new", speaker_id: "S1", first_seen_t: 0 }, seg(0, 10), diar(0, 10, [[0, 10, "S1"]], ["S1"])] },
      { events: [{ ...startedAt(10), started_at: "2026-09-23T11:00:00.000Z" } as SpeechEvent, seg(10.5, 15), diar(10, 15, [[10, 15, "S1"]], ["S1"])] },
    ]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    const first = (await speakersRepo.get(tx, created.id, "S1"))!.talk_s;
    expect(first).toBe(10);

    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry");
    clock.fireNext();
    await until(() => speech.connections.length === 2, "the second leg");
    await (await conn(speech, 1)).done;

    expect(speech.starts[1]?.start_at).toBe(10);
    expect((await speakersRepo.get(tx, created.id, "S1"))!.talk_s).toBe(15);
    expect((await sessions.get(tx, created.id))?.started_at).toBe(started.type === "session.started" ? started.started_at : "");
    await runner.stop(created.id);
  });
});

test("stop then an instant resume: the old leg's handler still in flight writes nothing after the new leg's cut", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let hold: Promise<void> | null = null;
    let release!: () => void;
    const db = hookedDb(tx, async (text) => {
      if (hold && text.startsWith("insert into events")) {
        const wait = hold;
        hold = null;
        await wait;
      }
    });
    const speech = scriptedSpeech([{ events: [started] }, { events: [startedAt(0)] }]);
    const runner = createSessionRunner({ db, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;

    hold = new Promise<void>((resolve) => (release = resolve));
    const late = (await conn(speech, 0)).emit(seg(0, 4, "late"));
    await settle();
    await runner.stop(created.id);
    await runner.resume(created.id);
    await (await conn(speech, 1)).done;
    release();
    await late;
    await settle();

    expect(await segments.list(tx, created.id, {})).toEqual([]);
    await runner.stop(created.id);
  });
});

test("resumeAll ends the leg rows a previous process left open", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [started] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await tx.query("update sessions set status = 'stopped' where status in ('starting', 'live', 'recovering') and id <> $1", [created.id]);
    await sessions.markStarted(tx, created.id, { startedAt: "2026-11-16T09:00:00.000Z", models: {} });
    const orphan = await legs.open(tx, created.id, { speechId: created.id, kind: "main", requestedT: 0 });
    await legs.started(tx, orphan.id, 0);

    await runner.resumeAll();
    await (await conn(speech, 0)).done;

    expect((await legRows(tx, created.id)).map((l) => l.end_reason)).toEqual(["api restarted", null]);
    await runner.stop(created.id);
  });
});

// --- Fix round 2 ---------------------------------------------------------------------------------------------------

test("a database error reading the event numbering during resumeAll is retried, and the next leg numbers after the stored events", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let failMaxSeq = true;
    const db = hookedDb(tx, (text) => {
      if (failMaxSeq && text.includes("coalesce(max(seq), 0)")) {
        failMaxSeq = false;
        throw new Error("too many connections");
      }
    });
    const speech = scriptedSpeech([{ events: [started, segment] }]);
    const runner = createSessionRunner({ db, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await tx.query("update sessions set status = 'stopped' where status in ('starting', 'live', 'recovering') and id <> $1", [created.id]);
    await sessions.markStarted(tx, created.id, { startedAt: "2026-11-16T09:00:00.000Z", models: {} });
    for (const seq of [1, 2, 3]) await events.append(tx, created.id, seq, "health", { t: seq });

    await runner.resumeAll();
    await until(() => clock.pending() === 1, "a retry after the failed read");
    clock.fireNext();
    await until(() => speech.connections.length === 1, "the leg");
    await (await conn(speech, 0)).done;

    expect((await events.list(tx, created.id)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect((await segments.list(tx, created.id, {})).map((s) => s.text)).toEqual(["hello"]);
    await runner.stop(created.id);
  });
});

test.each([
  ["markStarted", "update sessions set status = 'live'"],
  ["setRecovering", "update sessions set status = 'recovering'"],
])("a stopped video's late %s, answered after an instant resume, leaves the resumed video's status alone", async (kind, query) => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let armed = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let landed = false;
    // The write reaches Postgres at once; only its answer comes back late, as a slow connection would.
    const db: Queryable = {
      query: async <R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
        const result = await tx.query<R>(text, values);
        if (armed && text.startsWith(query)) {
          armed = false;
          landed = true;
          await held;
        }
        return result;
      },
    };
    const speech = scriptedSpeech([{ events: [] }, { events: [startedAt(0)] }]);
    const runner = createSessionRunner({ db, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;

    armed = true;
    const old = kind === "markStarted" ? (await conn(speech, 0)).emit(started) : (await conn(speech, 0)).drop("socket reset");
    await until(() => landed, "the old write");
    await runner.stop(created.id);
    await runner.resume(created.id);
    await (await conn(speech, 1)).done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    release();
    await old;
    await settle();

    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect(clock.pending()).toBe(0);
    expect(runner.live()).toEqual([created.id]);
    await runner.stop(created.id);
  });
});

test("a revive whose first write fails still opens a leg", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let failRecovering = true;
    const db = hookedDb(tx, (text) => {
      if (failRecovering && text.includes("status = 'recovering'")) {
        failRecovering = false;
        throw new Error("connection reset by peer");
      }
    });
    const speech = scriptedSpeech([{ events: [started] }]);
    const runner = createSessionRunner({ db, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, created.id, "degraded");

    await runner.resume(created.id);
    await until(() => speech.connections.length === 1, "the leg");
    await (await conn(speech, 0)).done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect(runner.live()).toEqual([created.id]);
    await runner.stop(created.id);
  });
});

// --- Fix round 3 ---------------------------------------------------------------------------------------------------

test("a replaced leg's session.started, held across a stop and an instant resume, does not mark the resumed video live", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    let hold: Promise<void> | null = null;
    let release!: () => void;
    let reached = false;
    const db = hookedDb(tx, async (text) => {
      if (hold && text.startsWith("update session_legs set start_t")) {
        const wait = hold;
        hold = null;
        reached = true;
        await wait;
      }
    });
    // The resumed leg connects but has not started yet: the video must stay recovering.
    const speech = scriptedSpeech([{ events: [] }, { events: [] }]);
    const runner = createSessionRunner({ db, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;

    hold = new Promise<void>((resolve) => (release = resolve));
    const old = (await conn(speech, 0)).emit(startedAt(5));
    await until(() => reached, "the old leg's started write");
    await runner.stop(created.id);
    await runner.resume(created.id);
    await (await conn(speech, 1)).done;
    release();
    await old;
    await settle();

    expect((await sessions.get(tx, created.id))?.status).toBe("recovering");
    expect(await gaps.open(tx, created.id)).toEqual([]);
    expect(runner.live()).toEqual([created.id]);
    await runner.stop(created.id);
  });
});

test("busy keeps a stopped video's id until its final loop run has settled", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    let finish!: () => void;
    const slow: ExtractorFactory = () => ({
      tick: async () => {}, advance: () => {}, cancelQueued: () => {}, stop: () => {}, drain: async () => true,
      flush: () => new Promise<void>((resolve) => (finish = resolve)),
    } as Extractor);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [slow] });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    expect(runner.busy()).toEqual([created.id]);
    await runner.stop(created.id);
    expect(runner.live()).toEqual([]);
    expect(runner.busy()).toEqual([created.id]);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.busy()).toEqual([]);
  });
});

test("a resume while a sweep holds the video opens its leg only after the held work settles", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, created.id, "stopped");
    let finish!: () => void;
    runner.hold(created.id, new Promise<void>((resolve) => (finish = resolve)));
    expect(runner.busy()).toEqual([created.id]);
    const resuming = runner.resume(created.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(speech.starts).toHaveLength(0);
    finish();
    await resuming;
    await speech.done;
    expect(runner.live()).toEqual([created.id]);
    expect(runner.busy()).toEqual([created.id]);
  });
});

// --- Final review fixes ----------------------------------------------------------------------------------------------

const TOO_OLD = "speech service too old to resume (update yt-stream speech)";
const { start_at: _ignored, ...startedWithoutStartAt } = started as Extract<SpeechEvent, { type: "session.started" }>;

test.each([
  ["omits start_at", startedWithoutStartAt as SpeechEvent],
  ["starts from 0 anyway", startedAt(0)],
])("a resume leg on a speech that %s is closed, not retried, and asks for a person", async (_name, first) => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [first, seg(0, 1.2, "again")] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await segments.insert(tx, created.id, { t0: 0, t1: 10, text: "before", words: [{ w: "before", t0: 0, t1: 10, p: 0.9, speaker_id: null }] });
    await sessions.setStatus(tx, created.id, "degraded");

    await runner.resume(created.id);
    await until(() => speech.connections.length === 1, "the leg");
    await (await conn(speech, 0)).done;
    await settle();

    const row = await sessions.get(tx, created.id);
    expect(row?.status).toBe("recovering");
    expect(row?.attention).toBe(TOO_OLD);
    expect(clock.pending()).toBe(0);
    expect((await conn(speech, 0)).isClosed()).toBe(true);
    expect((await segments.list(tx, created.id, {})).map((s) => s.text)).toEqual(["before"]);
    expect(await legRows(tx, created.id)).toEqual([{ requested_t: 10, start_t: null, end_reason: "error" }]);
    await runner.stop(created.id);
  });
});

test("a first leg from 0 on a speech that omits start_at still runs", async () => {
  await inRollback(async (tx) => {
    const speech = scriptedSpeech([{ events: [startedWithoutStartAt as SpeechEvent, seg(0, 1.2)] }]);
    const runner = createSessionRunner({ db: tx, hub: createHub(100), connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect(await segments.list(tx, created.id, {})).toHaveLength(1);
    await runner.stop(created.id);
  });
});

test("stop then an instant resume: the new leg and its extractor wait for the old extractor's final drain", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = scriptedSpeech([{ events: [started] }, { events: [started] }]);
    let finish!: () => void;
    let built = 0;
    const slow: ExtractorFactory = () => {
      built += 1;
      return {
        tick: async () => {}, advance: () => {}, cancelQueued: () => {}, stop: () => {}, drain: async () => true,
        flush: built === 1 ? () => new Promise<void>((resolve) => (finish = resolve)) : async () => {},
      } as Extractor;
    };
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, loops: [slow] });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    await runner.stop(created.id);
    await runner.resume(created.id);
    await settle();
    expect(speech.connections).toHaveLength(1);
    expect(built).toBe(1);
    finish();
    await until(() => speech.connections.length === 2, "the resumed leg");
    expect(built).toBe(2);
    await runner.stop(created.id);
  });
});

test("a resume answers once the video is marked recovering, while a hold is still pending; the leg opens after it", async () => {
  await inRollback(async (tx) => {
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub: createHub(100), connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, created.id, "stopped");
    let finish!: () => void;
    runner.hold(created.id, new Promise<void>((resolve) => (finish = resolve)));
    const answered = await runner.resume(created.id);
    expect(answered.status).toBe("recovering");
    expect(runner.wanted(created.id)).toBe(true);
    expect(speech.starts).toHaveLength(0);
    finish();
    await speech.done;
    expect(runner.wanted(created.id)).toBe(false);
    expect(runner.live()).toEqual([created.id]);
    await runner.stop(created.id);
  });
});

test("a resume closes a gap leg in flight instead of waiting for it, and the gap keeps its stage", async () => {
  await inRollback(async (tx) => {
    const speech = scriptedSpeech([{ events: [startedAt(400), seg(400, 405)] }, { events: [startedAt(405)] }]);
    const runner = createSessionRunner({ db: tx, hub: createHub(100), connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await segments.insert(tx, created.id, { t0: 0, t1: 10, text: "before", words: [{ w: "before", t0: 0, t1: 10, p: 0.9, speaker_id: null }] });
    await sessions.setStatus(tx, created.id, "stopped");
    const gap = await gaps.add(tx, created.id, 400, 600);
    const filling = runner.fillGap(created.id, gap);
    await (await conn(speech, 0)).done;

    await runner.resume(created.id);
    expect(await filling).toBe(false);
    expect((await conn(speech, 0)).isClosed()).toBe(true);
    await until(() => speech.connections.length === 2, "the resumed leg");
    await (await conn(speech, 1)).done;
    expect((await gaps.get(tx, gap.id))?.stage).toBeNull();
    const kinds = (await tx.query("select kind, end_reason from session_legs where session_id = $1 order by id", [created.id])).rows;
    expect(kinds).toEqual([{ kind: "gap", end_reason: "preempted" }, { kind: "main", end_reason: null }]);
    await runner.stop(created.id);
  });
});

const startedOn = (start_at: number, broadcast_start: number | null): SpeechEvent => ({ ...started, start_at, broadcast_start } as SpeechEvent);

test("stopping a recovering video records the stretch it missed as a gap, and a later leg that covers it supersedes it", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const broadcast = clock.now() / 1000 - 100;
    const speech = scriptedSpeech([{ events: [startedOn(0, broadcast), seg(0, 10)] }, { events: [startedOn(10, broadcast)] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry");
    clock.advance(60_000);

    await runner.stop(created.id);
    expect((await gaps.open(tx, created.id)).map((g) => [g.t0, g.t1])).toEqual([[10, 160]]);

    await runner.resume(created.id);
    await until(() => speech.connections.length === 2, "the resumed leg");
    await (await conn(speech, 1)).done;
    await settle();
    expect(await gaps.open(tx, created.id)).toEqual([]);
    await runner.stop(created.id);
  });
});

test("stopping a recovering video whose stream clock is unknown records no gap and says so", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [started, seg(0, 10)] }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    await (await conn(speech, 0)).drop("socket reset");
    await until(() => clock.pending() === 1, "a retry");

    await runner.stop(created.id);
    expect(await gaps.open(tx, created.id)).toEqual([]);
    expect((await sessions.get(tx, created.id))?.attention).toMatch(/not recorded as a gap/);
  });
});

test("stopping a live video records no gap", async () => {
  await inRollback(async (tx) => {
    const clock = fakeClock();
    const speech = scriptedSpeech([{ events: [startedOn(0, clock.now() / 1000 - 100), seg(0, 10)] }]);
    const runner = createSessionRunner({ db: tx, hub: createHub(100), connect: speech.connector, now: clock.now, setTimer: clock.setTimer });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await (await conn(speech, 0)).done;
    await runner.stop(created.id);
    expect(await gaps.open(tx, created.id)).toEqual([]);
  });
});
