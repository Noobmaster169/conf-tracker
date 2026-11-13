import { expect, test } from "vitest";

import { formatDay, formatDuration, formatT, initials, plannedTime, titleAndOrg } from "./format";

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

test("a duration reads in minutes, then hours and minutes", () => {
  expect([formatDuration(20), formatDuration(42 * 60), formatDuration(3 * 3600 + 5 * 60)]).toEqual(["under a minute", "42 min", "3 h 05 min"]);
});

test("a schedule day is written out without a time zone moving it; anything else is nothing", () => {
  expect(formatDay("2026-11-10")).toBe("Tue, 10 Nov 2026");
  expect(formatDay(null)).toBeNull();
  expect(formatDay("tomorrow")).toBeNull();
});

test("planned times, titles and initials are built from whatever is known", () => {
  expect([plannedTime("10:00", "10:30"), plannedTime("10:00", null), plannedTime(null, "10:30")]).toEqual(["10:00 to 10:30", "10:00", null]);
  expect(titleAndOrg({ title: "Co-Founder", org: "Solana Labs" })).toBe("Co-Founder, Solana Labs");
  expect(titleAndOrg({ title: null, org: "Solana Labs" })).toBe("Solana Labs");
  expect(titleAndOrg({ title: null, org: null })).toBeNull();
  expect([initials("Anatoly Yakovenko"), initials("Meow"), initials("  ")]).toEqual(["AY", "M", "?"]);
});

test("readableDescription drops the schedule's format label and what is not a sentence", async () => {
  const { readableDescription } = await import("./format");
  expect(readableDescription("Open/Close.")).toBeNull();
  expect(readableDescription("Product Keynote. 👀")).toBeNull();
  expect(readableDescription("")).toBeNull();
  expect(readableDescription(null)).toBeNull();
  expect(readableDescription("Product Keynote. A major announcement from the Temporal team.")).toBe("A major announcement from the Temporal team.");
  expect(readableDescription("Tokenisation is easy. Utilization is hard. Kash Dhana discusses it.")).toBe("Tokenisation is easy. Utilization is hard. Kash Dhana discusses it.");
});
