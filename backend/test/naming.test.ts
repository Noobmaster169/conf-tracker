import { expect, test } from "vitest";

import type { Speaker } from "../src/contracts";
import type { Line } from "../src/pipeline/lines";
import { judgeProposals, nameMap, renderNameWindow, resolveId, selectNameWindow } from "../src/pipeline/naming";

const speaker = (id: string, extra: Partial<Speaker> = {}): Speaker => ({
  speaker_id: id, first_seen_t: 0, last_seen_t: 0, talk_s: 0, merged_into: null,
  name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null, ...extra,
});
const line = (t0: number, speaker_id: string | null, text: string): Line => ({ segment_id: 1, t0, t1: t0 + 4, speaker_id, text });
const cfg = { name_window_s: 180, name_floor: 0.7 };

test("resolveId follows merges to the survivor and stops on a cycle; nameMap gives every label its survivor's name", () => {
  const roster = [speaker("S1", { name: "Tom Keene", name_confidence: 0.9 }), speaker("S2", { merged_into: "S1" }), speaker("S3", { merged_into: "S2" }), speaker("S4")];
  expect(resolveId(roster, "S3")).toBe("S1");
  expect(resolveId(roster, "S9")).toBe("S9");
  expect(resolveId([speaker("A", { merged_into: "B" }), speaker("B", { merged_into: "A" })], "A")).toMatch(/^[AB]$/);
  expect(Object.fromEntries(nameMap(roster))).toEqual({ S1: "Tom Keene", S2: "Tom Keene", S3: "Tom Keene" });
});

test("selectNameWindow keeps the last name_window_s, resolves merged labels, and is null when everyone in it is named", () => {
  const roster = [speaker("S1", { name: "Tom Keene", name_confidence: 0.9 }), speaker("S2"), speaker("S7", { merged_into: "S2" }), speaker("S10")];
  const lines = [line(0, "S10", "long ago"), line(200, "S1", "joining us now"), line(205, "S7", "thanks Tom"), line(250, null, "music")];
  const window = selectNameWindow(lines, roster, cfg);
  expect(window).toMatchObject({ t0: 200, t1: 254, present: ["S1", "S2"], candidates: ["S2"] });
  expect(window?.lines.map((l) => l.speaker_id)).toEqual(["S1", "S2", null]);
  expect(selectNameWindow([line(200, "S1", "only Tom")], roster, cfg)).toBeNull();
  expect(selectNameWindow([], roster, cfg)).toBeNull();
});

test("renderNameWindow lists who is present with any name held, then the lines", () => {
  const roster = [speaker("S1", { name: "Tom Keene", role: "host", name_confidence: 0.9 }), speaker("S2")];
  const window = selectNameWindow([line(60, "S1", "Joining us now is Cathie Wood."), line(64, "S2", "Thanks Tom.")], roster, cfg)!;
  expect(renderNameWindow(window, roster)).toBe(
    "## speakers\nS1: Tom Keene, host (confidence 0.90)\nS2: (unnamed)\n\n## transcript\n[01:00 S1] Joining us now is Cathie Wood.\n[01:04 S2] Thanks Tom.",
  );
});

test("judgeProposals accepts a verified, confident proposal for a present speaker, whoever said the quote", () => {
  const roster = [speaker("S1", { name: "Tom Keene", name_confidence: 0.9 }), speaker("S2")];
  const window = selectNameWindow([line(60, "S1", "Joining us now is Cathie Wood."), line(64, "S2", "Thanks Tom.")], roster, cfg)!;
  const judged = judgeProposals([{ speaker_id: "S2", name: "Cathie Wood", role: "guest", confidence: 0.92, quote: "Joining us now is Cathie Wood." }], window, roster, 0.7);
  expect(judged).toEqual([
    { speakerId: "S2", name: "Cathie Wood", role: "guest", confidence: 0.92, quote: "Joining us now is Cathie Wood.", quoteVerified: true, status: "accepted", reason: null },
  ]);
});

test("judgeProposals rejects below the floor, a speaker not in the window, an unfound quote, and a weaker rename, each with its reason", () => {
  const roster = [speaker("S1", { name: "Tom Keene", name_confidence: 0.9 }), speaker("S2"), speaker("S5")];
  const window = selectNameWindow([line(60, "S1", "Joining us now is Cathie Wood."), line(64, "S2", "Thanks Tom.")], roster, cfg)!;
  const base = { name: "Tom", role: null, quote: "Thanks Tom." };
  const judged = judgeProposals(
    [
      { ...base, speaker_id: "S2", confidence: 0.5 },
      { ...base, speaker_id: "S5", confidence: 0.95 },
      { ...base, speaker_id: "S2", confidence: 0.95, quote: "thanks tom" },
      { ...base, speaker_id: "S1", confidence: 0.8 },
    ],
    window,
    roster,
    0.7,
  );
  expect(judged.map((j) => [j.status, j.quoteVerified, j.reason])).toEqual([
    ["rejected", true, "confidence 0.50 is below the floor 0.70"],
    ["rejected", true, "S5 does not speak in the window"],
    ["rejected", false, "quote not in the window"],
    ["rejected", true, "S1 already has a name at 0.90"],
  ]);
});

test("judgeProposals lets a stronger rename through, and the second of two proposals for one speaker must beat the first", () => {
  const roster = [speaker("S1", { name: "Tom", name_confidence: 0.75 })];
  const window = selectNameWindow([line(0, "S1", "I'm Tom Keene.")], roster, { ...cfg, name_floor: 0.8 })!;
  const judged = judgeProposals(
    [
      { speaker_id: "S1", name: "Tom Keene", role: "host", confidence: 0.95, quote: "I'm Tom Keene." },
      { speaker_id: "S1", name: "Tom K", role: null, confidence: 0.9, quote: "I'm Tom Keene." },
    ],
    window,
    roster,
    0.7,
  );
  expect(judged.map((j) => [j.name, j.status, j.reason])).toEqual([
    ["Tom Keene", "accepted", null],
    ["Tom K", "rejected", "S1 already has a name at 0.95"],
  ]);
});

test("judgeProposals rejects a quote that never mentions the name, matching whole words of 2+ characters, case-insensitive", () => {
  const roster = [speaker("S1"), speaker("S2")];
  const window = selectNameWindow([line(0, "S1", "Thanks TOM."), line(4, "S2", "I also agree, K.")], roster, cfg)!;
  const judge = (name: string, quote: string) =>
    judgeProposals([{ speaker_id: "S2", name, role: null, confidence: 0.9, quote }], window, roster, 0.7).map((j) => [j.status, j.reason])[0];
  expect(judge("Jane Smith", "Thanks TOM.")).toEqual(["rejected", "quote does not contain the name"]);
  expect(judge("Tom Keene", "Thanks TOM.")).toEqual(["accepted", null]);
  expect(judge("tom", "Thanks TOM.")).toEqual(["accepted", null]);
  expect(judge("K", "I also agree, K.")).toEqual(["rejected", "quote does not contain the name"]);
  expect(judge("Al", "I also agree, K.")).toEqual(["rejected", "quote does not contain the name"]);
});
