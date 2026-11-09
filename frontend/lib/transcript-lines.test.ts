import { expect, test } from "vitest";

import type { Segment, Speaker } from "./api/schemas";
import { toLines } from "./transcript-lines";

const w = (text: string, t0: number, speaker_id: string | null) => ({ w: text, t0, t1: t0 + 0.4, p: 1, speaker_id });
const segment = (id: number, words: Segment["words"], text = words.map((x) => x.w).join(" ")): Segment => ({
  id, session_id: "s", t0: words[0]?.t0 ?? 0, t1: 99, text, words,
});
const merged: Speaker = { speaker_id: "S2", first_seen_t: 0, last_seen_t: 0, talk_s: 0, merged_into: "S1", name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null };

test("a segment splits into runs of the same resolved speaker", () => {
  const lines = toLines([segment(1, [w("a", 0, "S1"), w("b", 1, "S2"), w("c", 2, "S3"), w("d", 3, null)])], [merged], { 1: 5 });
  expect(lines.map((l) => [l.key, l.speakerId, l.text, l.t0, l.revision])).toEqual([
    ["1:0", "S1", "a b", 0, 5],
    ["1:1", "S3", "c d", 2, 5],
  ]);
});

test("an unlabelled word joins the run before it instead of splitting a sentence", () => {
  const lines = toLines([segment(1, [w("so", 0, "S1"), w("um", 1, null), w("yes", 2, "S1"), w("ok", 3, "S2")])], [], {});
  expect(lines.map((l) => [l.speakerId, l.text])).toEqual([["S1", "so um yes"], ["S2", "ok"]]);
});

test("leading unlabelled words join the first labelled run", () => {
  const lines = toLines([segment(1, [w("um", 0, null), w("so", 1, "S2"), w("hi", 2, "S1")])], [merged], {});
  expect(lines.map((l) => [l.speakerId, l.text, l.t0])).toEqual([["S1", "um so hi", 0]]);
});

test("a segment whose words are all unlabelled stays one unlabelled line", () => {
  const lines = toLines([segment(1, [w("a", 0, null), w("b", 1, null)])], [], {});
  expect(lines.map((l) => [l.key, l.speakerId, l.text])).toEqual([["1:0", null, "a b"]]);
});

test("a segment without words is one unlabelled line", () => {
  expect(toLines([segment(4, [], "raw")], [], {})).toEqual([{ key: "4:0", segmentId: 4, t0: 0, speakerId: null, text: "raw", revision: 0 }]);
});
