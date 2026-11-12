import { expect, test } from "vitest";

import { changedSettings, fieldKind, nextVersion, settingsDone } from "./agent-forms";

const setting = (key: string, value: unknown, fallback: unknown) => ({ key, value, default: fallback, fixed_at_start: false, valid: true });

test("nextVersion is one past the highest, whatever the order", () => {
  expect(nextVersion([{ version: "v5" }, { version: "v3" }, { version: "v4" }])).toBe("v6");
  expect(nextVersion([{ version: "v9" }, { version: "v10" }])).toBe("v11");
  expect(nextVersion([])).toBe("v1");
});

test("fieldKind follows the default's type", () => {
  expect([true, 30, "sonnet", { track: 1 }].map((d) => fieldKind({ default: d }))).toEqual(["boolean", "number", "text", "json"]);
});

test("changedSettings sends only what differs, reads numbers and switches, and an empty field goes back to the default", () => {
  const settings = [setting("name", true, true), setting("name_floor", 0.6, 0.7), setting("name_model", "sonnet", "sonnet"), setting("name_window_s", 180, 180), setting("slow_ms", { track: 1 }, { track: 1 })];
  const form: Record<string, string> = { name_floor: "", name_model: " opus ", name_window_s: "180", slow_ms: '{"track":2}' };
  expect(changedSettings(settings, (key) => form[key] ?? null)).toEqual({ name: false, name_floor: null, name_model: "opus", slow_ms: { track: 2 } });
  expect(changedSettings(settings, (key) => ({ name: "on", name_floor: "0.6", name_model: "sonnet", name_window_s: "180", slow_ms: '{"track":1}' })[key] ?? null)).toEqual({});
});

test("changedSettings names the field it cannot read", () => {
  expect(() => changedSettings([setting("name_floor", 0.7, 0.7)], () => "high")).toThrow('name_floor: "high" is not a number');
  expect(() => changedSettings([setting("slow_ms", {}, {})], () => "{oops")).toThrow("slow_ms: not valid JSON");
});

test("settingsDone says where it applied and what waits", () => {
  expect(settingsDone({ default_changed: true, sessions: [{ id: "a", title: "x" }, { id: "b", title: null }], waits_for_next_start: ["extract_interval_s"] })).toBe("Saved for new videos and 2 running videos. extract_interval_s waits for a video's next start.");
  expect(settingsDone({ default_changed: false, sessions: [{ id: "a", title: "x" }], waits_for_next_start: [] })).toBe("Saved for 1 running video.");
  expect(settingsDone({ default_changed: false, sessions: [], waits_for_next_start: [] })).toBe("Nothing changed: those are the values already in use.");
});

test("changedSettings with everything: each value shown is sent, so running videos can be brought to what the form shows", () => {
  const settings = [setting("name", true, true), setting("name_floor", 0.6, 0.7), setting("name_model", "sonnet", "sonnet")];
  const form: Record<string, string> = { name: "on", name_floor: "0.6", name_model: "sonnet" };
  // A value at its default is sent as null: "take it back to the default", which removes a video's own override.
  expect(changedSettings(settings, (key) => form[key] ?? null, true)).toEqual({ name: null, name_floor: 0.6, name_model: null });
  expect(changedSettings(settings, (key) => form[key] ?? null)).toEqual({});
});
