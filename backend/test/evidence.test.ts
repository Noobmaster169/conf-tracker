import { expect, test } from "vitest";

import { isDuplicate, locateQuote, normalise } from "../src/pipeline/evidence";
import type { Line } from "../src/pipeline/lines";

const line = (t0: number, t1: number, text: string, speaker_id: string | null = "S1"): Line => ({ segment_id: 1, t0, t1, speaker_id, text });
const lines = [
  line(0, 4, "Welcome back to Bloomberg This Weekend.", "S8"),
  line(4, 9, "The Fed will cut in   December, I think", "S11"),
  line(9, 12, "rates are heading lower.", "S11"),
  line(12, 15, "rates are heading lower, you said?", "S8"),
];

test("normalise collapses whitespace and trims, nothing else", () => {
  expect(normalise("  The Fed\twill\n cut  ")).toBe("The Fed will cut");
  expect(normalise("Rates")).not.toBe("rates");
});

test("a quote inside one line gives that line's speaker and time", () => {
  expect(locateQuote(lines, "The Fed will cut in December")).toEqual({ speaker_id: "S11", t0: 4, t1: 9 });
});

test("a quote across two lines takes the first line's speaker and spans both", () => {
  expect(locateQuote(lines, "I think rates are heading lower.")).toEqual({ speaker_id: "S11", t0: 4, t1: 12 });
});

test("the last occurrence wins", () => {
  expect(locateQuote(lines, "rates are heading lower")).toEqual({ speaker_id: "S8", t0: 12, t1: 15 });
});

test("locateQuote answers null when one character differs, and for an empty quote", () => {
  expect(locateQuote(lines, "the Fed will cut in December")).toBeNull();
  expect(locateQuote(lines, "The Fed will cut in December...")).toBeNull();
  expect(locateQuote(lines, "   ")).toBeNull();
  expect(locateQuote([], "anything")).toBeNull();
});

test("a quote on an unlabelled line locates with a null speaker", () => {
  expect(locateQuote([line(0, 2, "oil to ninety dollars", null)], "oil to ninety")).toEqual({ speaker_id: null, t0: 0, t1: 2 });
});

test("isDuplicate matches a prior claim's text or quote after normalising and lower-casing, and never on an empty quote", () => {
  const prior = [{ claim: "The Fed will cut in December.", quote: "The Fed will cut in   December" }];
  expect(isDuplicate({ claim: "the fed will cut in december.", quote: "something else" }, prior)).toBe(true);
  expect(isDuplicate({ claim: "A different claim", quote: "The Fed will cut in December" }, prior)).toBe(true);
  expect(isDuplicate({ claim: "A different claim", quote: "other words" }, prior)).toBe(false);
  expect(isDuplicate({ claim: "A different claim", quote: "" }, [{ claim: "x", quote: "" }])).toBe(false);
});
