import type { AgentDefinition } from "../agents/agent";
import type { RunStatus, WatchSettings } from "../contracts-agents";

/**
 * What the Watcher looks for, as one pure function over facts someone else gathered. No model is asked: these rules
 * must hold when the model is down, which is when they are needed most.
 */
export type Rule = "agent_failing" | "agent_slow" | "agent_quiet" | "video_attention" | "video_degraded" | "proxy_down" | "speech_down" | "box_stale" | "deploy_failed";

export interface Finding {
  rule: Rule;
  agentId: string | null;
  sessionId: string | null;
  callId: number | null;
  title: string;
  detail: string;
  /** The system trouble that explains this one, when that trouble was found in the same pass. */
  parentRule: Rule | null;
}

export interface WatchFacts {
  videos: {
    id: string;
    title: string;
    status: string;
    attention: string | null;
    isReplay: boolean;
    /** The runner holds it: its agents are running. One it does not hold is judged for its own state only. */
    held: boolean;
    /** Its stage has sessions on its schedule. Without any, the tracker has nothing to track and makes no call. */
    hasSchedule: boolean;
    /** Where the transcript reaches, in stream seconds. */
    transcriptT: number;
    config: Record<string, unknown>;
    /** Per agent id: its newest runs on this video, newest first, and where its furthest window ends. */
    agents: Record<string, { runs: { id: number; status: RunStatus; error: string | null }[]; lastWindowT1: number }>;
  }[];
  /** Probes failed in a row, this pass included. */
  proxyFails: number;
  speechFails: number;
  box: { ageS: number | null; failed: string | null };
}

/** Only these have an interval the transcript can outrun: the namer waits for an unnamed voice, the summarizer for a session to end. */
const CAN_GO_QUIET = new Set(["track", "extract"]);

const newestAll = (runs: { status: RunStatus }[], n: number, status: RunStatus): boolean => runs.length >= n && runs.slice(0, n).every((run) => run.status === status);

/** A video agent's setting on this video: what its config says, or the schema's default. */
function setting(agent: AgentDefinition, config: Record<string, unknown>, key: string): unknown {
  if (key in config) return config[key];
  return (agent.settings?.parse({}) as Record<string, unknown> | undefined)?.[key];
}

export function evaluate(facts: WatchFacts, settings: WatchSettings, agents: AgentDefinition[]): Finding[] {
  const system: Finding[] = [];
  const add = (list: Finding[], rule: Rule, title: string, more: Partial<Finding> = {}) => list.push({ rule, agentId: null, sessionId: null, callId: null, title, detail: "", parentRule: null, ...more });

  if (facts.proxyFails >= settings.probe_passes) add(system, "proxy_down", "The model proxy does not answer");
  if (facts.speechFails >= settings.probe_passes) add(system, "speech_down", "Speech does not answer");
  if (facts.box.ageS !== null && facts.box.ageS > settings.box_stale_s) add(system, "box_stale", "The box has stopped reporting", { detail: `Its last report is ${Math.round(facts.box.ageS / 60)} minutes old.` });
  if (facts.box.failed) add(system, "deploy_failed", "A deploy failed", { detail: facts.box.failed });

  const found: Finding[] = [];
  for (const video of facts.videos) {
    if (video.isReplay) continue;
    for (const agent of agents) {
      // Old runs prove nothing about agents that are not running.
      if (!video.held || agent.internal || agent.settingsScope !== "video") continue;
      const seen = video.agents[agent.id] ?? { runs: [], lastWindowT1: 0 };
      const about = { agentId: agent.id, sessionId: video.id, parentRule: "proxy_down" as const };
      const failing = newestAll(seen.runs, settings.fail_runs, "failed");
      if (failing) {
        add(found, "agent_failing", `${agent.name} failed ${settings.fail_runs} times in a row on ${video.title}`, { ...about, callId: seen.runs[0]!.id, detail: seen.runs[0]!.error ?? "" });
      }
      if (newestAll(seen.runs, settings.slow_runs, "slow")) add(found, "agent_slow", `${agent.name} is slow on ${video.title}`, { ...about, callId: seen.runs[0]!.id });
      const interval = agent.trigger.intervalKey ? Number(setting(agent, video.config, agent.trigger.intervalKey)) : Number.NaN;
      const on = setting(agent, video.config, agent.id) !== false;
      // A failing agent is not also quiet: its failures are why the transcript ran ahead of it.
      const idleByDesign = agent.id === "track" && !video.hasSchedule;
      if (!failing && !idleByDesign && CAN_GO_QUIET.has(agent.id) && video.status === "live" && on && Number.isFinite(interval) && video.transcriptT - seen.lastWindowT1 > settings.quiet_intervals * interval) {
        add(found, "agent_quiet", `${agent.name} has gone quiet on ${video.title}`, {
          ...about,
          detail: `The transcript is ${Math.round(video.transcriptT - seen.lastWindowT1)} s past its last run.`,
        });
      }
    }
    if (video.attention !== null) add(found, "video_attention", `${video.title} needs attention`, { sessionId: video.id, detail: video.attention, parentRule: "speech_down" });
    if (video.status === "degraded") add(found, "video_degraded", `${video.title} stopped by itself`, { sessionId: video.id });
  }

  const present = new Set(system.map((finding) => finding.rule));
  return [...system, ...found.map((finding) => (finding.parentRule && present.has(finding.parentRule) ? finding : { ...finding, parentRule: null }))];
}
