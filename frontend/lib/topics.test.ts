import { expect, test } from "vitest";

import { topicsRange } from "./topics";

test("topicsRange is the last ten minutes, snapped up to 30 s and never below zero", () => {
  expect(topicsRange(0)).toEqual({ from: 0, to: 0 });
  expect(topicsRange(95)).toEqual({ from: 0, to: 120 });
  expect(topicsRange(1201)).toEqual({ from: 630, to: 1230 });
  expect(topicsRange(1210)).toEqual(topicsRange(1229));
});
