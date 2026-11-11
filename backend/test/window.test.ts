import { expect, test } from "vitest";

import type { Line } from "../src/pipeline/lines";
import { mmss, renderLine, renderWindow, selectWindow } from "../src/pipeline/window";

const line = (t0: number, t1: number, text: string, speaker_id: string | null = "S1"): Line => ({ segment_id: 1, t0, t1, speaker_id, text });
const cfg = { context_tail_s: 60, extract_max_s: 120 };
const minute = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => line((from + i) * 10, (from + i) * 10 + 9, `line ${from + i}`));

test("at the start everything is fresh and there is no context", () => {
  const window = selectWindow(minute(0, 3), 0, cfg);
  expect(window).toEqual({ context: [], fresh: minute(0, 3), t0: 0, t1: 29 });
});

test("lines ending at or before the cursor are context within the tail, later ones are fresh", () => {
  const lines = minute(0, 12); // t 0 to 119
  const window = selectWindow(lines, 60, cfg)!;
  expect(window.fresh.map((l) => l.t0)).toEqual([60, 70, 80, 90, 100, 110]);
  expect(window.context.map((l) => l.t0)).toEqual([0, 10, 20, 30, 40, 50]);
  expect([window.t0, window.t1]).toEqual([0, 119]);
});

test("nothing fresh means no window", () => {
  expect(selectWindow(minute(0, 3), 29, cfg)).toBeNull();
  expect(selectWindow([], 0, cfg)).toBeNull();
});

test("a window after an outage starts at the cursor, not at the last extract_max_s", () => {
  const lines = minute(0, 61); // t 0 to 609, cursor at 100 after a long outage
  const window = selectWindow(lines, 100, cfg)!;
  expect(window.fresh[0]?.t0).toBe(100);
  expect(window.fresh.at(-1)!.t1).toBeLessThanOrEqual(220);
  expect(window.fresh.map((l) => l.t0)).toEqual([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210]);
  expect(window.context.map((l) => l.t0)).toEqual([40, 50, 60, 70, 80, 90]);
  expect([window.t0, window.t1]).toEqual([40, 219]);
});

test("one fresh line longer than extract_max_s is still a window of its own", () => {
  const window = selectWindow([line(0, 5, "a"), line(10, 300, "long"), line(300, 305, "b")], 5, cfg)!;
  expect(window.fresh.map((l) => l.text)).toEqual(["long"]);
});

test("rendering: mm:ss, the speaker tag, the sections", () => {
  expect([mmss(0), mmss(65.7), mmss(3600)]).toEqual(["00:00", "01:05", "60:00"]);
  expect(renderLine(line(65.7, 70, "hello there", "S3"))).toBe("[01:05 S3] hello there");
  expect(renderLine(line(1, 2, "x", null))).toBe("[00:01 --] x");
  const rendered = renderWindow({ context: [line(0, 5, "before")], fresh: [line(60, 65, "after", "S2")], t0: 0, t1: 65 }, [{ claim: "Rates will fall." }]);
  expect(rendered).toBe(
    "## already extracted\n- Rates will fall.\n\n## context (already handled, for reference only)\n[00:00 S1] before\n\n## new lines (extract from these)\n[01:00 S2] after",
  );
  expect(renderWindow({ context: [], fresh: [line(0, 1, "a")], t0: 0, t1: 1 }, [])).toContain("## already extracted\n(none)\n\n## context (already handled, for reference only)\n(none)");
});

test("renderLine puts a known name after the id, and leaves unnamed and unlabelled lines as they were", () => {
  const names = new Map([["S3", "Cathie Wood"]]);
  expect(renderLine({ segment_id: 1, t0: 65, t1: 70, speaker_id: "S3", text: "Rates will fall." }, names)).toBe("[01:05 S3 Cathie Wood] Rates will fall.");
  expect(renderLine({ segment_id: 1, t0: 65, t1: 70, speaker_id: "S4", text: "Yes." }, names)).toBe("[01:05 S4] Yes.");
  expect(renderLine({ segment_id: 1, t0: 65, t1: 70, speaker_id: null, text: "Music." }, names)).toBe("[01:05 --] Music.");
});
