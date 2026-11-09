import { expect, test } from "vitest";

import { delayed, nextRevealAt } from "./delay";

const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

test("delayed shows snapshot segments at once and holds a live one back until its time", () => {
  const arrivals = { 2: 10_000, 3: 25_000 };
  expect(delayed(items, arrivals, 20_000, 0).map((i) => i.id)).toEqual([1, 2, 3]);
  expect(delayed(items, arrivals, 20_000, 30).map((i) => i.id)).toEqual([1]);
  expect(delayed(items, arrivals, 40_000, 30).map((i) => i.id)).toEqual([1, 2]);
  expect(delayed(items, arrivals, 55_000, 30).map((i) => i.id)).toEqual([1, 2, 3]);
  expect(delayed(items, arrivals, 0, 30).map((i) => i.id)).toEqual([1]);
});

test("nextRevealAt is when the next held line is due, and null when nothing is held", () => {
  const arrivals = { 2: 10_000, 3: 25_000 };
  expect(nextRevealAt(items, arrivals, 20_000, 30)).toBe(40_000);
  expect(nextRevealAt(items, arrivals, 0, 30)).toBe(40_000);
  expect(nextRevealAt(items, arrivals, 45_000, 30)).toBe(55_000);
  expect(nextRevealAt(items, arrivals, 55_000, 30)).toBeNull();
  expect(nextRevealAt(items, arrivals, 20_000, 0)).toBeNull();
});
