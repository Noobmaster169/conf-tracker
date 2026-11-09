import { expect, test } from "vitest";

import { assignWords, sameSpeakers, speakerAt } from "../src/pipeline/assign";

const turns = [
  { t0: 0, t1: 5, speaker_id: "S1" },
  { t0: 5, t1: 9, speaker_id: "S2" },
  { t0: 12, t1: 15, speaker_id: "S1" },
];

test.each([
  ["inside one turn", 1, 2, "S1"],
  ["straddling, the larger overlap wins", 4.5, 6, "S2"],
  ["an exact tie goes to the earlier turn", 4.5, 5.5, "S1"],
  ["in the gap between turns", 9.5, 11.5, null],
  ["after every turn", 20, 21, null],
  ["touching a boundary without overlap", 9, 10, null],
])("speakerAt %s", (_name, t0, t1, expected) => {
  expect(speakerAt(turns, t0, t1)).toBe(expected);
});

test("assignWords labels each word and leaves words outside every turn null", () => {
  const words = [
    { w: "a", t0: 1, t1: 1.5, p: 1 },
    { w: "b", t0: 10, t1: 10.5, p: 1 },
    { w: "c", t0: 13, t1: 13, p: 1 },
  ];
  expect(assignWords(words, turns).map((w) => w.speaker_id)).toEqual(["S1", null, "S1"]);
  expect(assignWords(words, []).map((w) => w.speaker_id)).toEqual([null, null, null]);
});

test("sameSpeakers compares labels only", () => {
  const a = assignWords([{ w: "a", t0: 1, t1: 2, p: 1 }], turns);
  const b = assignWords([{ w: "a", t0: 1, t1: 2, p: 1 }], [{ t0: 0, t1: 5, speaker_id: "S2" }]);
  expect(sameSpeakers(a, a)).toBe(true);
  expect(sameSpeakers(a, b)).toBe(false);
});
