import { expect, test } from "vitest";

import type { Span } from "../src/contracts";
import { decide, type Read } from "../src/pipeline/tracking";

const span = (talkId: number | null, t0 = 0): Span => ({ id: 1, session_id: "s", talk_id: talkId, state: talkId === null ? "break" : "talk", t0, t1: null, confidence: 0.9, source: "tracker" });
const read = (extra: Partial<Read>): Read => ({ state: "talk", talkId: 2, confidence: 0.9, quoteT0: 600, t: 660, ...extra });

test("a sure read with its evidence in the transcript switches at once, dated to the evidence", () => {
  expect(decide(span(1), null, read({}), 0.8)).toEqual({ kind: "switch", state: "talk", talkId: 2, t: 600, confidence: 0.9 });
  expect(decide(null, null, read({}), 0.8)).toMatchObject({ kind: "switch", talkId: 2, t: 600 });
});

test("a weaker read, or one whose quote was not found, waits for a second read to agree", () => {
  const weak = read({ confidence: 0.6 });
  expect(decide(span(1), null, weak, 0.8)).toEqual({ kind: "keep", pending: weak });
  expect(decide(span(1), weak, read({ confidence: 0.65, quoteT0: 640, t: 720 }), 0.8)).toEqual({ kind: "switch", state: "talk", talkId: 2, t: 600, confidence: 0.65 });
  const unfound = read({ quoteT0: null });
  expect(decide(span(1), null, unfound, 0.8)).toEqual({ kind: "keep", pending: unfound });
  expect(decide(span(1), unfound, read({ quoteT0: null, t: 720 }), 0.8)).toMatchObject({ kind: "switch", t: 660 });
});

test("the belief stands on the same answer, an unknown, a guess, or two reads that disagree", () => {
  expect(decide(span(2), read({ talkId: 3 }), read({}), 0.8)).toEqual({ kind: "keep", pending: null });
  expect(decide(span(1), read({}), read({ state: "unknown", talkId: null }), 0.8)).toEqual({ kind: "keep", pending: null });
  expect(decide(span(1), null, read({ confidence: 0.3 }), 0.8)).toEqual({ kind: "keep", pending: null });
  const other = read({ talkId: 3, confidence: 0.6 });
  expect(decide(span(1), read({ confidence: 0.6 }), other, 0.8)).toEqual({ kind: "keep", pending: other });
});

test("a break is a state like any other: entered on evidence, and left for a talk", () => {
  expect(decide(span(1), null, read({ state: "break", talkId: null }), 0.8)).toEqual({ kind: "switch", state: "break", talkId: null, t: 600, confidence: 0.9 });
  expect(decide(span(null), null, read({ state: "break", talkId: null }), 0.8)).toEqual({ kind: "keep", pending: null });
  expect(decide(span(null), null, read({}), 0.8)).toMatchObject({ kind: "switch", state: "talk", talkId: 2 });
});
