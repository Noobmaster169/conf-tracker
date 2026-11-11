import { afterAll, expect, test } from "vitest";

import { closePool } from "../src/db";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import * as diarization from "../src/repositories/diarization";
import { resumePoint, speakerFloor, truncateAfter } from "../src/repositories/resume";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import { inRollback } from "./db";

afterAll(closePool);

const newSession = (tx: Parameters<typeof sessions.create>[0]) =>
  sessions.create(tx, { sourceUrl: "https://www.youtube.com/watch?v=QB5BNdBFujE", sourceFile: null, config: {} });
const seg = (tx: Parameters<typeof sessions.create>[0], id: string, t0: number, t1: number) =>
  segments.insert(tx, id, { t0, t1, text: "x", words: [] });
const win = (tx: Parameters<typeof sessions.create>[0], id: string, t0: number, t1: number) =>
  diarization.insertWindow(tx, id, { t0, t1, gpuMs: 1, matches: [], turns: [{ t0, t1, speaker_id: "S1" }] });

test("resume point is the segment end, lowered to the window end, rounded down to 0.5; 0 when empty", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    expect(await resumePoint(tx, s.id)).toBe(0);
    await seg(tx, s.id, 100, 120);
    await seg(tx, s.id, 120, 130.2);
    expect(await resumePoint(tx, s.id)).toBe(130);
    await win(tx, s.id, 90, 120);
    expect(await resumePoint(tx, s.id)).toBe(120);
    await win(tx, s.id, 100, 140);
    expect(await resumePoint(tx, s.id)).toBe(130);
  });
});

test("truncateAfter cuts segments, windows and their turns past t, and leaves claims", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    await seg(tx, s.id, 100, 120);
    await seg(tx, s.id, 120, 130.2);
    await win(tx, s.id, 90, 120);
    await win(tx, s.id, 100, 125);
    const call = await calls.insert(tx, s.id, {
      step: "extract", promptVersion: "v1", model: "m", windowT0: 0, windowT1: 30, attempt: 1,
      input: "", output: "{}", parsed: {}, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, error: null,
    });
    await claims.insertMany(tx, s.id, call.id, [{
      speakerId: "S1", t0: 125, t1: 126, claim: "c", topics: [], polarity: "neutral", quote: "q", quoteVerified: true, status: "ok",
    }]);
    await truncateAfter(tx, s.id, 120);
    expect((await segments.list(tx, s.id, {})).map((x) => x.t1)).toEqual([120]);
    const { rows: w } = await tx.query("select t1 from diar_windows where session_id = $1", [s.id]);
    expect(w.map((r) => r.t1)).toEqual([120]);
    const { rows: t } = await tx.query("select t1 from turns where session_id = $1", [s.id]);
    expect(t.map((r) => r.t1)).toEqual([120]);
    const { rows: c } = await tx.query("select t0 from claims where session_id = $1", [s.id]);
    expect(c.map((r) => r.t0)).toEqual([125]);
  });
});

test("speakerFloor is the highest SN, ignoring other ids; 0 when none", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    expect(await speakerFloor(tx, s.id)).toBe(0);
    for (const id of ["S1", "S4", "S12", "S2x", "guest"]) await speakers.upsert(tx, s.id, { speakerId: id, firstSeenT: 0, lastSeenT: 1 });
    await speakers.markMerged(tx, s.id, "S12", "S1");
    expect(await speakerFloor(tx, s.id)).toBe(12);
  });
});

test("the resume point never falls inside a stored segment, so the line is re-read whole", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    await seg(tx, s.id, 100, 115);
    await seg(tx, s.id, 115, 130);
    await win(tx, s.id, 90, 120);
    const r = await resumePoint(tx, s.id);
    expect(r).toBe(115);
    await truncateAfter(tx, s.id, r);
    expect((await segments.list(tx, s.id, {})).map((x) => [x.t0, x.t1])).toEqual([[100, 115]]);
  });
});
