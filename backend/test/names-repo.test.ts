import { afterAll, expect, test } from "vitest";

import { closePool } from "../src/db";
import * as calls from "../src/repositories/calls";
import * as names from "../src/repositories/names";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const newSession = (tx: Parameters<typeof sessions.create>[0]) => sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
const newCall = (costUsd: number | null): calls.NewCall => ({
  step: "name", promptVersion: "v1", model: "haiku", windowT0: 0, windowT1: 180, attempt: 1, input: "## speakers", output: null,
  parsed: null, inputTokens: null, outputTokens: null, costUsd, latencyMs: 300, error: costUsd === null ? "llm-proxy unreachable" : null,
});
const proposal = (speakerId: string, status: names.NewProposal["status"], reason: string | null = null): names.NewProposal => ({
  speakerId, name: `Name of ${speakerId}`, role: null, confidence: status === "accepted" ? 0.9 : 0.4, quote: "I'm here", quoteVerified: true, status, reason,
});

test("insertMany keeps the answer's order; forCall and forSpeaker read them back, a speaker's newest first", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const first = await calls.insert(tx, s.id, newCall(0.001));
    const second = await calls.insert(tx, s.id, newCall(0.002));
    const stored = await names.insertMany(tx, s.id, first.id, [proposal("S1", "accepted"), proposal("S2", "rejected", "confidence 0.40 is below the floor 0.70")]);
    expect(stored.map((p) => [p.speaker_id, p.status, p.reason, p.call_id])).toEqual([
      ["S1", "accepted", null, first.id],
      ["S2", "rejected", "confidence 0.40 is below the floor 0.70", first.id],
    ]);
    await names.insertMany(tx, s.id, second.id, [proposal("S1", "rejected", "S1 already has a name at 0.90")]);

    expect(await names.forCall(tx, first.id)).toEqual(stored);
    expect((await names.forSpeaker(tx, s.id, "S1")).map((p) => p.call_id)).toEqual([second.id, first.id]);
    expect(await names.forSpeaker(tx, s.id, "S9")).toEqual([]);
  });
});

test("forSpeaker on a survivor also reads the proposals made for labels merged into it, newest first", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const call = await calls.insert(tx, s.id, newCall(0.001));
    for (const [id, t] of [["S1", 0], ["S2", 6], ["S3", 10]] as const) await speakers.upsert(tx, s.id, { speakerId: id, firstSeenT: t, lastSeenT: t + 3 });
    const [p1, p2, p3] = await names.insertMany(tx, s.id, call.id, [proposal("S1", "accepted"), proposal("S2", "accepted"), proposal("S3", "accepted")]);
    await speakers.markMerged(tx, s.id, "S2", "S1");
    expect((await names.forSpeaker(tx, s.id, "S1")).map((p) => p.id)).toEqual([p2!.id, p1!.id]);
    expect((await names.forSpeaker(tx, s.id, "S3")).map((p) => p.id)).toEqual([p3!.id]);
  });
});

test("totalCost sums a session's calls and counts a failed call as nothing", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const other = await newSession(tx);
    expect(await calls.totalCost(tx, s.id)).toBe(0);
    await calls.insert(tx, s.id, newCall(0.25));
    await calls.insert(tx, s.id, newCall(null));
    await calls.insert(tx, s.id, newCall(0.5));
    await calls.insert(tx, other.id, newCall(9));
    expect(await calls.totalCost(tx, s.id)).toBeCloseTo(0.75);
  });
});

test("totalCost up to a call id leaves out calls after it, so the snapshot and the live events count each call once", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const first = await calls.insert(tx, s.id, newCall(0.25));
    const second = await calls.insert(tx, s.id, newCall(0.5));
    await calls.insert(tx, s.id, newCall(1));
    expect(await calls.totalCost(tx, s.id, first.id)).toBeCloseTo(0.25);
    expect(await calls.totalCost(tx, s.id, second.id)).toBeCloseTo(0.75);
    expect(await calls.totalCost(tx, s.id, 0)).toBe(0);
    expect(await calls.totalCost(tx, s.id)).toBeCloseTo(1.75);
  });
});
