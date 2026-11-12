import { expect, test } from "vitest";

import { agoText, clockText, dotClass, lastRunText } from "./agents";
import { AgentCard } from "./api/agent-schemas";

const now = new Date("2026-11-12T12:00:00Z");

test("agoText says how long ago in the largest whole unit, and that an agent has not run", () => {
  expect(agoText(null, now)).toBe("has not run yet");
  expect(agoText("2026-11-12T11:59:48Z", now)).toBe("12 s ago");
  expect(agoText("2026-11-12T11:56:00Z", now)).toBe("4 min ago");
  expect(agoText("2026-11-12T09:00:00Z", now)).toBe("3 h ago");
  expect(agoText("2026-11-10T12:00:00Z", now)).toBe("2 d ago");
  expect(agoText("2026-11-12T12:00:05Z", now)).toBe("just now");
  expect(agoText("not a date", now)).toBe("has not run yet");
});

test("clockText is a 24-hour UTC time with the day when it is not today", () => {
  expect(clockText("2026-11-12T09:05:07Z", now)).toBe("09:05:07");
  expect(clockText("2026-11-10T09:05:07Z", now)).toBe("10 Nov 09:05");
});

test("each status has its own dot", () => {
  expect(new Set(["ok", "failed", "slow", "idle"].map((s) => dotClass(s as "ok"))).size).toBe(4);
  expect(dotClass("failed")).toContain("bg-live");
});

test("a card for an agent that never ran parses", () => {
  const card = AgentCard.parse({ id: "watch", name: "Watcher", role: "r", trigger: "t", internal: true, prompt_version: null, model: null, status: "idle", last_run_at: null, recent: [], open_incidents: 0 });
  expect(card.recent).toEqual([]);
});

test("lastRunText: the Watcher having asked nothing is not the same as an agent that never ran", () => {
  expect(lastRunText({ internal: true, last_run_at: null }, now)).toBe("nothing to look into yet");
  expect(lastRunText({ internal: false, last_run_at: null }, now)).toBe("has not run yet");
  expect(lastRunText({ internal: true, last_run_at: "2026-11-12T11:56:00Z" }, now)).toBe("4 min ago");
});
