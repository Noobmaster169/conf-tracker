import { expect, test } from "vitest";

import { FrameSettings } from "../src/contracts-frames";
import { createJudge, motionBetween, same, SIG_CELLS, SIG_W } from "../src/frames/signature";

const t = FrameSettings.parse({});
const fill = (v: number) => new Uint8Array(SIG_CELLS).fill(v);
/** A white "slide" on the left two thirds with a band of "text" at row `row`, and a "speaker" on the right of shade `who`. */
function frame(row: number, who: number): Uint8Array {
  const s = fill(20);
  for (let y = 0; y < 36; y++)
    for (let x = 0; x < SIG_W; x++) {
      if (x < 42) s[y * SIG_W + x] = y >= row && y < row + 3 ? 40 : 230;
      else if (y > 8) s[y * SIG_W + x] = who + ((x + y) % 3);
    }
  return s;
}
const still = new Uint8Array(SIG_CELLS);

test("the same picture is the same, and a different one is not", () => {
  expect(same({ sig: fill(100), motion: still }, { sig: fill(102), motion: still }, t)).toBe(true);
  expect(same({ sig: fill(30), motion: still }, { sig: fill(200), motion: still }, t)).toBe(false);
});

test("a speaker moving beside the same slide is the same frame; another slide with the same template is not", () => {
  const a = frame(5, 80);
  const moved = frame(5, 140);
  const speakerCells = motionBetween(a, moved);
  expect(same({ sig: a, motion: speakerCells }, { sig: moved, motion: speakerCells }, t)).toBe(true);
  const otherSlide = frame(20, 80);
  // Only the text band changed: under the coarse share, but the fine test over the still slide sees it.
  expect(same({ sig: a, motion: still }, { sig: otherSlide, motion: still }, t)).toBe(false);
});

test("the judge keeps a grab once the next shows it settled, never a crossfade, and nothing twice", () => {
  const judge = createJudge([], []);
  const slide = frame(5, 80);
  const fade = fill(128);
  const kept: string[] = [];
  const offer = (sig: Uint8Array, name: string) => {
    const r = judge.offer(sig, name, t);
    if (r) kept.push(r.keep.payload);
  };
  offer(fade, "fade"); // a candidate
  offer(slide, "slide-1"); // far from the fade: the fade never settles, the slide is the candidate
  offer(frame(5, 81), "slide-2"); // settles slide-1: kept
  offer(slide, "slide-3"); // a candidate again
  offer(slide, "slide-4"); // settles slide-3, which is slide-1 again: dropped
  offer(frame(20, 80), "next-1");
  offer(frame(20, 80), "next-2");
  expect(kept).toEqual(["slide-1", "next-1"]);
});

test("a blocked screen never gets in", () => {
  const card = fill(60);
  const judge = createJudge([], [{ sig: card, motion: still }]);
  expect(judge.offer(card, 1, t)).toBeNull();
  expect(judge.offer(card, 2, t)).toBeNull();
  expect(judge.offer(card, 3, t)).toBeNull();
});
