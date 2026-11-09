import { expect, test } from "vitest";

import { REPLAY_SETTINGS } from "./replay-settings";

const fallback = (key: string) => REPLAY_SETTINGS.flatMap((g) => g.items).find(([k]) => k === key)?.[1];

test("the replay panel shows the backend's default extract prompt, v3 (v1 and v2 were removed)", () => {
  expect(fallback("extract_prompt")).toBe("v3");
});
