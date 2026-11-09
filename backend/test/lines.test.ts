import { expect, test } from "vitest";

import type { Segment } from "../src/contracts";
import { segmentsToLines } from "../src/pipeline/lines";

const w = (text: string, t0: number, speaker_id: string | null) => ({ w: text, t0, t1: t0 + 0.4, p: 1, speaker_id });
const segment = (id: number, words: Segment["words"], text = words.map((x) => x.w).join(" ")): Segment => ({
  id, session_id: "s", t0: words[0]?.t0 ?? 0, t1: words.at(-1)?.t1 ?? 1, text, words,
});

test("a segment splits into runs of the same speaker with the run's time span", () => {
  const lines = segmentsToLines([segment(1, [w("a", 0, "S1"), w("b", 1, "S1"), w("c", 2, "S2")])]);
  expect(lines).toEqual([
    { segment_id: 1, t0: 0, t1: 1.4, speaker_id: "S1", text: "a b" },
    { segment_id: 1, t0: 2, t1: 2.4, speaker_id: "S2", text: "c" },
  ]);
});

test("an unlabelled word joins its previous neighbour, or the first labelled one when it leads", () => {
  const lines = segmentsToLines([segment(1, [w("um", 0, null), w("a", 1, "S1"), w("b", 2, null), w("c", 3, "S2")])]);
  expect(lines.map((l) => [l.speaker_id, l.text])).toEqual([["S1", "um a b"], ["S2", "c"]]);
});

test("a segment with no labels at all is one unlabelled line, and one without words uses the segment text", () => {
  expect(segmentsToLines([segment(2, [w("a", 0, null), w("b", 1, null)])])).toEqual([{ segment_id: 2, t0: 0, t1: 1.4, speaker_id: null, text: "a b" }]);
  expect(segmentsToLines([segment(3, [], "raw text")])).toEqual([{ segment_id: 3, t0: 0, t1: 1, speaker_id: null, text: "raw text" }]);
});
