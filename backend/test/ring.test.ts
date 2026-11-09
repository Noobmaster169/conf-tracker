import { expect, test } from "vitest";

import { createRing } from "../src/realtime/ring";

const item = (seq: number) => ({ seq });

test("since returns everything after seq while it is still held", () => {
  const ring = createRing<{ seq: number }>(3);
  [1, 2, 3].forEach((n) => ring.push(item(n)));
  expect(ring.since(0)).toEqual([item(1), item(2), item(3)]);
  expect(ring.since(2)).toEqual([item(3)]);
  expect(ring.since(3)).toEqual([]);
  expect(ring.since(7)).toBeNull();
  expect(ring.lastSeq()).toBe(3);
});

test("since returns null when seq is older than the ring", () => {
  const ring = createRing<{ seq: number }>(2);
  [1, 2, 3, 4].forEach((n) => ring.push(item(n)));
  expect(ring.since(1)).toBeNull();
  expect(ring.since(2)).toEqual([item(3), item(4)]);
});

test("an empty ring answers [] for seq 0 and null for anything it never held", () => {
  const ring = createRing<{ seq: number }>(2);
  expect(ring.since(0)).toEqual([]);
  expect(ring.since(5)).toBeNull();
});
