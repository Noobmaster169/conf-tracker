import { expect, it } from "vitest";

import { listSteps } from "../src/agents/prompts/registry";
import { agentById, agentForKey, AGENTS } from "../src/agents/registry";
import { ExtractConfig, NameConfig } from "../src/contracts";
import { PostConfig, SummaryConfig, TrackConfig } from "../src/contracts-conference";

it("has the six agents, ids equal to their prompt directories", () => {
  expect(AGENTS.map((a) => a.id)).toEqual(["track", "name", "extract", "summarize", "post", "watch"]);
  for (const a of AGENTS) expect(listSteps()).toContain(a.id);
});

it("every setting of every video agent is owned by exactly one agent", () => {
  for (const key of Object.keys({ ...ExtractConfig.parse({}), ...NameConfig.parse({}), ...TrackConfig.parse({}), ...SummaryConfig.parse({}), ...PostConfig.parse({}) })) {
    expect(agentForKey(key)?.settingsScope, key).toBe("video");
    expect(AGENTS.filter((a) => a.settings && key in a.settings.shape).length, key).toBe(1);
  }
  expect(agentForKey("extract_prompt")?.id).toBe("extract");
  expect(agentForKey("nope")).toBeNull();
});

it("describes a call in one line", () => {
  const none = { claims: 0, named: [], switchedTo: null, summaryOf: null };
  expect(agentById("extract")!.describe({ error: null, parsed: {} }, { ...none, claims: 3 })).toBe("3 claims");
  expect(agentById("extract")!.describe({ error: null, parsed: {} }, { ...none, claims: 1 })).toBe("1 claim");
  expect(agentById("extract")!.describe({ error: null, parsed: {} }, none)).toBe("No claims");
  expect(agentById("track")!.describe({ error: null, parsed: { state: "talk" } }, { ...none, switchedTo: "DePIN panel" })).toBe('Switched to "DePIN panel"');
  expect(agentById("track")!.describe({ error: null, parsed: { state: "talk" } }, none)).toBe("Still on the same session");
  expect(agentById("track")!.describe({ error: null, parsed: { state: "break" } }, none)).toBe("Break");
  expect(agentById("track")!.describe({ error: null, parsed: { state: "unknown" } }, none)).toBe("Not sure");
  expect(agentById("name")!.describe({ error: null, parsed: {} }, { ...none, named: [{ voice: "S2", name: "Kevin B." }] })).toBe("Named S2 as Kevin B.");
  expect(agentById("name")!.describe({ error: null, parsed: {} }, { ...none, named: [{ voice: "S2", name: "Kevin B." }, { voice: "S4", name: "Ana" }, { voice: "S5", name: "Li" }] })).toBe("Named S2 as Kevin B. and 2 more");
  expect(agentById("name")!.describe({ error: null, parsed: {} }, none)).toBe("No one named");
  expect(agentById("summarize")!.describe({ error: null, parsed: { headline: "Roadmap" } }, none)).toBe('Wrote "Roadmap"');
  expect(agentById("post")!.describe({ error: null, parsed: { post: "🔴 Just wrapped: Fireside Chat with Anatoly\n\n• a\n• b" } }, none)).toBe('Posted "Fireside Chat with Anatoly"');
  expect(agentById("post")!.describe({ error: null, parsed: null }, none)).toBe("Wrote a post");
  expect(agentById("watch")!.describe({ error: null, parsed: { cause: "The model login expired.", fix: "x" } }, none)).toBe("The model login expired.");
  expect(agentById("name")!.describe({ error: "speakers.0.confidence: Required", parsed: null }, none)).toBe("Failed: speakers.0.confidence: Required");
  expect(agentById("extract")!.describe({ error: "x".repeat(200), parsed: null }, none)).toBe(`Failed: ${"x".repeat(80)}`);
});
