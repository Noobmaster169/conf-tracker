import { expect, test } from "vitest";

import { speakerColor } from "./speaker-color";

test.each([
  ["S1", "var(--spk-1)"],
  ["S8", "var(--spk-8)"],
  ["S9", "var(--spk-1)"],
  [null, "var(--ink-dim)"],
  ["odd", "var(--ink-dim)"],
])("speakerColor(%s)", (id, expected) => {
  expect(speakerColor(id)).toBe(expected);
});
