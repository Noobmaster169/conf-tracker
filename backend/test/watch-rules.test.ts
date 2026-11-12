import { expect, it } from "vitest";

import { AGENTS } from "../src/agents/registry";
import { WatchSettings } from "../src/contracts-agents";
import { evaluate, type WatchFacts } from "../src/ingest/watch-rules";

const settings = WatchSettings.parse({});
type Video = WatchFacts["videos"][number];
type Runs = Video["agents"][string]["runs"];

const runs = (...statuses: ("ok" | "failed" | "slow")[]): Runs => statuses.map((status, i) => ({ id: 100 - i, status, error: status === "failed" ? `error ${100 - i}` : null }));
const video = (over: Partial<Video> = {}): Video => ({ id: "v1", title: "Main Stage", status: "live", attention: null, isReplay: false, held: true, hasSchedule: true, transcriptT: 0, transcriptIdleS: 0, config: {}, agents: {}, ...over });
const facts = (over: Partial<WatchFacts> = {}): WatchFacts => ({ videos: [], proxyFails: 0, speechFails: 0, box: { ageS: 60, failed: null }, ...over });
const found = (f: WatchFacts, s = settings) => evaluate(f, s, AGENTS);
const rules = (f: WatchFacts, s = settings) => found(f, s).map((x) => x.rule);

it("nothing wrong → []", () => {
  expect(found(facts())).toEqual([]);
  expect(found(facts({ videos: [video({ agents: { extract: { runs: runs("ok", "ok", "ok"), lastWindowT1: 0, waitingS: 999 } } })] }))).toEqual([]);
});

it("agent_failing: the newest three runs all failed", () => {
  const [f] = found(facts({ videos: [video({ agents: { extract: { runs: runs("failed", "failed", "failed", "ok"), lastWindowT1: 0, waitingS: 999 } } })] }));
  expect(f).toEqual({ rule: "agent_failing", agentId: "extract", sessionId: "v1", callId: 100, title: "Extractor failed 3 times in a row on Main Stage", detail: "error 100", parentRule: null });
});

it("two failures then a success is not failing, and two failures are not three", () => {
  expect(rules(facts({ videos: [video({ agents: { extract: { runs: runs("failed", "failed", "ok"), lastWindowT1: 0, waitingS: 999 } } })] }))).toEqual([]);
  expect(rules(facts({ videos: [video({ agents: { extract: { runs: runs("failed", "failed"), lastWindowT1: 0, waitingS: 999 } } })] }))).toEqual([]);
  expect(rules(facts({ videos: [video({ agents: { extract: { runs: runs("ok", "failed", "failed", "failed"), lastWindowT1: 0, waitingS: 999 } } })] }))).toEqual([]);
});

it("agent_slow: the newest three runs all slow", () => {
  const [f] = found(facts({ videos: [video({ agents: { name: { runs: runs("slow", "slow", "slow"), lastWindowT1: 0, waitingS: 999 } } })] }));
  expect(f).toMatchObject({ rule: "agent_slow", agentId: "name", title: "Namer is slow on Main Stage", callId: 100 });
});

it("fail_runs is read from the settings", () => {
  const v = video({ agents: { extract: { runs: runs("failed", "failed"), lastWindowT1: 0, waitingS: 999 } } });
  expect(rules(facts({ videos: [v] }), WatchSettings.parse({ fail_runs: 2 }))).toEqual(["agent_failing"]);
});

it("a replay is never watched", () => {
  const v = video({ isReplay: true, status: "degraded", attention: "speech unreachable", agents: { extract: { runs: runs("failed", "failed", "failed"), lastWindowT1: 0, waitingS: 999 } } });
  expect(found(facts({ videos: [v] }))).toEqual([]);
});

it("agent_quiet: the transcript is more than five intervals past the agent's last run", () => {
  const quiet = video({ transcriptT: 500, agents: { extract: { runs: runs("ok"), lastWindowT1: 300, waitingS: 999 }, track: { runs: runs("ok"), lastWindowT1: 300, waitingS: 999 } } });
  const got = found(facts({ videos: [quiet] }));
  // extract: 5 × 30 = 150 < 200 → quiet. track: 5 × 60 = 300 > 200 → not.
  expect(got.map((f) => [f.rule, f.agentId])).toEqual([["agent_quiet", "extract"]]);
  expect(got[0]!.title).toBe("Extractor has gone quiet on Main Stage");
  expect(rules(facts({ videos: [video({ ...quiet, config: { extract_interval_s: 60 } })] }))).toEqual([]);
});

it("quiet: not while recovering, not when the agent is switched off, not for the namer or summarizer", () => {
  const agents = { track: { runs: runs("ok"), lastWindowT1: 5000, waitingS: 999 }, extract: { runs: runs("ok"), lastWindowT1: 0, waitingS: 999 }, name: { runs: runs("ok"), lastWindowT1: 0, waitingS: 999 }, summarize: { runs: [], lastWindowT1: 0, waitingS: 999 } };
  expect(rules(facts({ videos: [video({ status: "recovering", transcriptT: 5000, agents })] }))).toEqual([]);
  expect(rules(facts({ videos: [video({ transcriptT: 5000, config: { extract: false }, agents })] }))).toEqual([]);
  expect(found(facts({ videos: [video({ transcriptT: 5000, agents })] })).map((f) => f.agentId)).toEqual(["extract"]);
});

it("quiet: an agent that never ran on a live video with a long transcript is quiet", () => {
  expect(found(facts({ videos: [video({ transcriptT: 5000, agents: {} })] })).map((f) => [f.rule, f.agentId])).toEqual([["agent_quiet", "track"], ["agent_quiet", "extract"]]);
});

it("video_attention and video_degraded", () => {
  const got = found(facts({ videos: [video({ status: "recovering", attention: "speech unreachable" }), video({ id: "v2", title: "Stage 2", status: "degraded" })] }));
  expect(got.map((f) => [f.rule, f.sessionId, f.title, f.detail])).toEqual([
    ["video_attention", "v1", "Main Stage needs attention", "speech unreachable"],
    ["video_degraded", "v2", "Stage 2 stopped by itself", ""],
  ]);
});

it("proxy_down and speech_down need two failed passes in a row", () => {
  expect(rules(facts({ proxyFails: 1, speechFails: 1 }))).toEqual([]);
  const got = found(facts({ proxyFails: 2, speechFails: 3 }));
  expect(got.map((f) => [f.rule, f.title, f.agentId, f.sessionId])).toEqual([
    ["proxy_down", "The model proxy does not answer", null, null],
    ["speech_down", "Speech does not answer", null, null],
  ]);
});

it("a failing agent is filed under proxy_down only while the proxy is down; attention under speech_down", () => {
  const v = video({ attention: "speech unreachable", agents: { extract: { runs: runs("failed", "failed", "failed"), lastWindowT1: 0, waitingS: 999 } } });
  const up = found(facts({ videos: [v] }));
  expect(up.map((f) => [f.rule, f.parentRule])).toEqual([["agent_failing", null], ["video_attention", null]]);
  const down = found(facts({ videos: [v], proxyFails: 2, speechFails: 2 }));
  expect(down.map((f) => [f.rule, f.parentRule])).toEqual([["proxy_down", null], ["speech_down", null], ["agent_failing", "proxy_down"], ["video_attention", "speech_down"]]);
});

it("box_stale past ten minutes; a box that never reported is not stale", () => {
  expect(rules(facts({ box: { ageS: 601, failed: null } }))).toEqual(["box_stale"]);
  expect(rules(facts({ box: { ageS: 600, failed: null } }))).toEqual([]);
  expect(rules(facts({ box: { ageS: null, failed: null } }))).toEqual([]);
});

it("deploy_failed carries what the box said", () => {
  expect(found(facts({ box: { ageS: 10, failed: "abc123 3" } }))).toEqual([{ rule: "deploy_failed", agentId: null, sessionId: null, callId: null, title: "A deploy failed", detail: "abc123 3", parentRule: null }]);
});

it("the Watcher's own runs are never judged", () => {
  expect(found(facts({ videos: [video({ agents: { watch: { runs: runs("failed", "failed", "failed"), lastWindowT1: 0, waitingS: 999 } } })] }))).toEqual([]);
});

it("an agent that is failing is not also reported as quiet: the failures are why the transcript ran ahead", () => {
  const v = video({ transcriptT: 5000, agents: { track: { runs: runs("ok"), lastWindowT1: 5000, waitingS: 999 }, extract: { runs: runs("failed", "failed", "failed"), lastWindowT1: 0, waitingS: 999 } } });
  expect(found(facts({ videos: [v] })).map((f) => f.rule)).toEqual(["agent_failing"]);
});

it("the tracker is not quiet on a video whose stage has no schedule: it has nothing to track", () => {
  const v = video({ hasSchedule: false, transcriptT: 5000, agents: { extract: { runs: runs("ok"), lastWindowT1: 5000, waitingS: 999 } } });
  expect(found(facts({ videos: [v] }))).toEqual([]);
});

it("a video nobody holds is judged for its own state only: its agents are not running, so their old runs prove nothing", () => {
  const v = video({ held: false, status: "degraded", transcriptT: 5000, agents: { extract: { runs: runs("failed", "failed", "failed"), lastWindowT1: 0, waitingS: 999 } } });
  expect(found(facts({ videos: [v] })).map((f) => f.rule)).toEqual(["video_degraded"]);
});

it("quiet: not over a break, when no new lines are arriving, however far the last line reached", () => {
  // The last line before lunch reached 181 s past the extractor's last window, then nothing came for minutes.
  const v = video({ transcriptT: 8276, transcriptIdleS: 600, agents: { extract: { runs: runs("ok"), lastWindowT1: 8095, waitingS: 600 }, track: { runs: runs("ok"), lastWindowT1: 8095, waitingS: 600 } } });
  expect(found(facts({ videos: [v] }))).toEqual([]);
});

it("quiet: not when speech comes back after a break and the agent has not had two minutes with the new lines", () => {
  const v = video({ transcriptT: 10435, agents: { extract: { runs: runs("ok"), lastWindowT1: 10435, waitingS: 0 }, track: { runs: runs("ok"), lastWindowT1: 8276, waitingS: 20 } } });
  expect(found(facts({ videos: [v] }))).toEqual([]);
});

it("quiet: lines still arriving that have waited more than two minutes on the agent", () => {
  const v = video({ transcriptT: 5000, transcriptIdleS: 5, agents: { extract: { runs: runs("ok"), lastWindowT1: 4000, waitingS: 121 }, track: { runs: runs("ok"), lastWindowT1: 5000, waitingS: 0 } } });
  expect(found(facts({ videos: [v] })).map((f) => [f.rule, f.agentId])).toEqual([["agent_quiet", "extract"]]);
});
