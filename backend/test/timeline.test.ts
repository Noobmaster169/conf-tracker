import { describe, expect, test } from "vitest";

import { addAlias, currentTurns, effectiveTurns, emptyTimeline, pushWindow, resolve, talkSeconds, type TimelineWindow } from "../src/pipeline/timeline";

const turn = (t0: number, t1: number, speaker_id: string) => ({ t0, t1, speaker_id });
const win = (t0: number, t1: number, turns: ReturnType<typeof turn>[]): TimelineWindow => ({ t0, t1, turns });

describe("effectiveTurns", () => {
  test.each([
    ["one window is taken whole", [win(0, 10, [turn(1, 4, "S1"), turn(4, 9, "S2")])], [turn(1, 4, "S1"), turn(4, 9, "S2")]],
    [
      "a later window wins the region it covers",
      [win(0, 10, [turn(0, 10, "S1")]), win(5, 15, [turn(5, 15, "S2")])],
      [turn(0, 5, "S1"), turn(5, 15, "S2")],
    ],
    [
      "an older turn is clipped at the next window's start and dropped when nothing is left",
      [win(0, 10, [turn(2, 3, "S1"), turn(6, 9, "S1")]), win(5, 15, [])],
      [turn(2, 3, "S1")],
    ],
    ["no windows, no turns", [], []],
  ])("%s", (_name, windows, expected) => {
    expect(effectiveTurns(windows)).toEqual(expected);
  });
});

test("pushWindow keeps at most `keep` windows and moves the dropped window's talk into finalTalk", () => {
  let tl = emptyTimeline();
  tl = pushWindow(tl, win(0, 10, [turn(0, 10, "S1")]), 2);
  tl = pushWindow(tl, win(5, 15, [turn(5, 15, "S2")]), 2);
  tl = pushWindow(tl, win(10, 20, [turn(10, 20, "S2")]), 2);
  expect(tl.windows.map((w) => w.t0)).toEqual([5, 10]);
  expect(tl.finalTalk).toEqual({ S1: 5 });
  expect(talkSeconds(tl)).toEqual({ S1: 5, S2: 15 });
});

test("a window that arrives out of order is placed by t0", () => {
  let tl = emptyTimeline();
  tl = pushWindow(tl, win(10, 20, []));
  tl = pushWindow(tl, win(0, 10, []));
  expect(tl.windows.map((w) => w.t0)).toEqual([0, 10]);
});

test("talkSeconds folds merged speakers into the survivor, also through chains", () => {
  let tl = pushWindow(emptyTimeline(), win(0, 30, [turn(0, 10, "S1"), turn(10, 20, "S2"), turn(20, 30, "S3")]));
  tl = addAlias(addAlias(tl, "S3", "S2"), "S2", "S1");
  expect(resolve(tl, "S3")).toBe("S1");
  expect(talkSeconds(tl)).toEqual({ S1: 30 });
  expect(currentTurns(tl).map((t) => t.speaker_id)).toEqual(["S1", "S1", "S1"]);
});

test("resolve survives an alias cycle", () => {
  const tl = addAlias(addAlias(emptyTimeline(), "S1", "S2"), "S2", "S1");
  expect(["S1", "S2"]).toContain(resolve(tl, "S1"));
});
