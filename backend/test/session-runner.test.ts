import { afterAll, expect, test } from "vitest";

import type { LiveEvent, SpeechEvent } from "../src/contracts";
import { closePool } from "../src/db";
import { fakeSpeech } from "../src/ingest/__fakes__/fake-speech";
import type { Extractor, ExtractorFactory } from "../src/ingest/extractor";
import { createLoop } from "../src/ingest/loop";
import { createSessionRunner } from "../src/ingest/session-runner";
import { TerminalError } from "../src/lib/errors";
import { createHub } from "../src/realtime/hub";
import * as callsRepo from "../src/repositories/calls";
import * as events from "../src/repositories/events";
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

    expect(speech.starts[0]).toEqual({ session_id: created.id, url: URL, file: undefined, speed: 2, config: { speed: 2 } });
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

test("a session that speech ends with an error is stopped and keeps the message", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started, { type: "session.ended", reason: "error", message: "yt-dlp failed" }]);
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });

    await runner.start(created.id);
    await speech.done;

    const final = await sessions.get(tx, created.id);
    expect(final?.status).toBe("stopped");
    expect(final?.error).toBe("yt-dlp failed");
    expect(final?.stopped_at).not.toBeNull();
  });
});

test("marks the session degraded when speech closes unexpectedly", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const speech = fakeSpeech([started], { closeAfter: false });
    const runner = createSessionRunner({ db: tx, hub, connect: speech.connector });
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await runner.start(created.id);
    await speech.done;
    expect((await sessions.get(tx, created.id))?.status).toBe("live");
    expect(runner.live()).toEqual([created.id]);

    await speech.drop("socket reset");
    expect((await sessions.get(tx, created.id))?.status).toBe("degraded");
    expect(runner.live()).toEqual([]);
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
