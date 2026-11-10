import { afterAll, expect, test } from "vitest";

import { closePool } from "../src/db";
import * as calls from "../src/repositories/calls";
import * as diarization from "../src/repositories/diarization";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const newSession = (tx: Parameters<typeof sessions.create>[0]) => sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });

test("upsert creates a speaker, then widens its seen range and keeps talk time unless given", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    expect(await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 5, lastSeenT: 5 })).toEqual({
      speaker_id: "S1", first_seen_t: 5, last_seen_t: 5, talk_s: 0, merged_into: null,
      name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null, person_id: null,
    });
    await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 8, lastSeenT: 20, talkS: 12.5 });
    const again = await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 3, lastSeenT: 10 });
    expect(again).toMatchObject({ first_seen_t: 3, last_seen_t: 20, talk_s: 12.5 });
  });
});

test("markMerged names the survivor, list orders by first seen, get answers null for unknown", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    await speakers.upsert(tx, s.id, { speakerId: "S2", firstSeenT: 9, lastSeenT: 9 });
    await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 1, lastSeenT: 1 });
    expect((await speakers.markMerged(tx, s.id, "S2", "S1"))?.merged_into).toBe("S1");
    expect((await speakers.list(tx, s.id)).map((x) => x.speaker_id)).toEqual(["S1", "S2"]);
    expect(await speakers.get(tx, s.id, "S9")).toBeNull();
    expect(await speakers.markMerged(tx, s.id, "S9", "S1")).toBeNull();
  });
});

test("insertWindow stores the window and its turns; windowsFor finds windows a speaker was matched in", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const m = (sid: string | null) => ({ local: "SPEAKER_00", speech_s: 5, speaker_id: sid, scores: {}, new: false });
    const w1 = await diarization.insertWindow(tx, s.id, { t0: 0, t1: 10, gpuMs: 100, matches: [m("S1")], turns: [{ t0: 1, t1: 4, speaker_id: "S1" }] });
    await diarization.insertWindow(tx, s.id, { t0: 0, t1: 20, gpuMs: 110, matches: [m("S2")], turns: [] });
    const w3 = await diarization.insertWindow(tx, s.id, { t0: 0, t1: 30, gpuMs: 120, matches: [m("S1"), m(null)], turns: [] });
    expect(w1).toMatchObject({ t0: 0, t1: 10, gpu_ms: 100 });
    expect((await diarization.windowsFor(tx, s.id, "S1")).map((w) => w.id)).toEqual([w3.id, w1.id]);
    const { rows } = await tx.query("select t0, t1, speaker_id from turns where window_id = $1", [w1.id]);
    expect(rows).toEqual([{ t0: 1, t1: 4, speaker_id: "S1" }]);
  });
});

test("overlapping finds segments crossing a range; updateWords replaces words", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const word = { w: "a", t0: 0, t1: 1, p: 1, speaker_id: null };
    for (const [t0, t1] of [[0, 5], [5, 10], [12, 15]] as const) await segments.insert(tx, s.id, { t0, t1, text: "a", words: [{ ...word, t0, t1 }] });
    const hits = await segments.overlapping(tx, s.id, 4, 12);
    expect(hits.map((x) => x.t0)).toEqual([0, 5]);
    const updated = await segments.updateWords(tx, hits[0]!.id, [{ ...word, speaker_id: "S1" }]);
    expect(updated.words[0]?.speaker_id).toBe("S1");
    await expect(segments.updateWords(tx, 987654321, [])).rejects.toThrow(/not found/);
  });
});

const nameCall = (tx: Parameters<typeof sessions.create>[0], sessionId: string) =>
  calls.insert(tx, sessionId, {
    step: "name", promptVersion: "v1", model: "haiku", windowT0: 0, windowT1: 180, attempt: 1, input: "## speakers", output: '{"proposals":[]}',
    parsed: { proposals: [] }, inputTokens: 10, outputTokens: 2, costUsd: 0.0005, latencyMs: 300, error: null,
  });

test("setName stores a name with its evidence, and a later upsert keeps it", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const call = await nameCall(tx, s.id);
    await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 5 });
    expect(await speakers.get(tx, s.id, "S1")).toMatchObject({ name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null });

    const named = await speakers.setName(tx, s.id, "S1", { name: "Cathie Wood", role: "guest", confidence: 0.9, quote: "joining us is Cathie Wood", callId: call.id });
    expect(named).toMatchObject({ speaker_id: "S1", name: "Cathie Wood", role: "guest", name_confidence: 0.9, name_quote: "joining us is Cathie Wood", name_call_id: call.id });
    await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 20, talkS: 12 });
    expect((await speakers.get(tx, s.id, "S1"))?.name).toBe("Cathie Wood");
    expect(await speakers.setName(tx, s.id, "S99", { name: "Nobody", role: null, confidence: 0.9, quote: "x", callId: call.id })).toBeNull();
  });
});

test("setName refuses a speaker merged away, so the name cannot land on a label nobody reads", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const call = await nameCall(tx, s.id);
    for (const [id, t] of [["S1", 0], ["S2", 6]] as const) await speakers.upsert(tx, s.id, { speakerId: id, firstSeenT: t, lastSeenT: t + 3 });
    await speakers.markMerged(tx, s.id, "S2", "S1");
    expect(await speakers.setName(tx, s.id, "S2", { name: "Cathie Wood", role: null, confidence: 0.9, quote: "I'm Cathie Wood", callId: call.id })).toBeNull();
    expect((await speakers.get(tx, s.id, "S2"))?.name).toBeNull();
  });
});

test("setName refuses a weaker or equal confidence than the name held and accepts a stronger one", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const call = await nameCall(tx, s.id);
    await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 5 });
    await speakers.setName(tx, s.id, "S1", { name: "Cathie Wood", role: "guest", confidence: 0.8, quote: "I'm Cathie Wood", callId: call.id });
    expect(await speakers.setName(tx, s.id, "S1", { name: "Tom Keene", role: null, confidence: 0.7, quote: "I'm Tom Keene", callId: call.id })).toBeNull();
    expect(await speakers.setName(tx, s.id, "S1", { name: "Tom Keene", role: null, confidence: 0.8, quote: "I'm Tom Keene", callId: call.id })).toBeNull();
    expect((await speakers.get(tx, s.id, "S1"))?.name).toBe("Cathie Wood");
    expect(await speakers.setName(tx, s.id, "S1", { name: "Cathie Wood", role: "CEO of Ark Invest", confidence: 0.95, quote: "Cathie Wood of Ark", callId: call.id }))
      .toMatchObject({ name: "Cathie Wood", role: "CEO of Ark Invest", name_confidence: 0.95 });
  });
});

test("inheritName gives the survivor the more confident name only", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const call = await nameCall(tx, s.id);
    for (const [id, t] of [["S1", 0], ["S2", 6], ["S3", 10]] as const) await speakers.upsert(tx, s.id, { speakerId: id, firstSeenT: t, lastSeenT: t + 3 });
    await speakers.setName(tx, s.id, "S2", { name: "Cathie Wood", role: "guest", confidence: 0.9, quote: "I'm Cathie Wood", callId: call.id });

    expect(await speakers.inheritName(tx, s.id, "S2", "S1")).toMatchObject({
      speaker_id: "S1", name: "Cathie Wood", role: "guest", name_confidence: 0.9, name_quote: "I'm Cathie Wood", name_call_id: call.id,
    });

    await speakers.setName(tx, s.id, "S3", { name: "Tom Keene", role: "host", confidence: 0.75, quote: "I'm Tom Keene", callId: call.id });
    expect(await speakers.inheritName(tx, s.id, "S3", "S1")).toBeNull();
    expect((await speakers.get(tx, s.id, "S1"))?.name).toBe("Cathie Wood");
    expect(await speakers.inheritName(tx, s.id, "S1", "S99")).toBeNull();
  });
});
