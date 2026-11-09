import { expect, test } from "vitest";

import { formatT, shortModel, wallTime } from "./format";

test.each([
  [0, "00:00"],
  [5.4, "00:05"],
  [65, "01:05"],
  [3599.9, "59:59"],
  [3600, "1:00:00"],
  [37230, "10:20:30"],
])("formatT(%s) = %s", (seconds, expected) => {
  expect(formatT(seconds)).toBe(expected);
});

test("wallTime adds stream seconds to the start, or is null without one", () => {
  expect(wallTime(null, 10)).toBeNull();
  const iso = wallTime("2026-09-23T10:00:00.000Z", 90.4);
  expect(iso).toBe(new Date("2026-09-23T10:01:30.400Z").toLocaleTimeString([], { hour12: false }));
});

test("shortModel keeps the text after the last slash", () => {
  expect(shortModel("pyannote/speaker-diarization-3.1")).toBe("speaker-diarization-3.1");
  expect(shortModel("plain")).toBe("plain");
  expect(shortModel("trailing/")).toBe("trailing/");
  expect(shortModel(undefined)).toBeNull();
  expect(shortModel("")).toBeNull();
});
