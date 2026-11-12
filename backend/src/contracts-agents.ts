import { z } from "zod";

/** How one run of an agent went. Failed beats slow. */
export const RunStatus = z.enum(["ok", "failed", "slow"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** The Watcher's settings: one set for the whole app, kept under the `watcher` setting. Every key has a default. */
export const WatchSettings = z.object({
  enabled: z.boolean().default(true),
  // This many runs in a row, newest first, make an agent "failing" or "slow".
  fail_runs: z.number().int().min(1).default(3),
  slow_runs: z.number().int().min(1).default(3),
  // An agent with an interval is quiet when the transcript is this many of its intervals past its last run.
  quiet_intervals: z.number().positive().default(5),
  // A run slower than this, per agent id, is slow. An agent not listed uses 60 s.
  slow_ms: z.record(z.string(), z.number().positive()).default({ track: 60_000, name: 60_000, extract: 60_000, summarize: 180_000, watch: 60_000 }),
  // The proxy or speech must fail this many passes in a row before it is an incident.
  probe_passes: z.number().int().min(1).default(2),
  box_stale_s: z.number().positive().default(600),
  // An open incident closes itself after this many passes without its condition.
  clear_passes: z.number().int().min(1).default(3),
  diagnose: z.boolean().default(true),
  watch_model: z.string().min(1).default("haiku"),
  watch_prompt: z.string().regex(/^v\d+$/).default("v1"),
});
export type WatchSettings = z.infer<typeof WatchSettings>;

export const DEFAULT_SLOW_MS = 60_000;
export const slowMsFor = (settings: WatchSettings, agentId: string): number => settings.slow_ms[agentId] ?? DEFAULT_SLOW_MS;

/** What the Watcher answers about an incident. */
export const WatchOutput = z.object({ cause: z.string().min(1), fix: z.string().min(1) });
export type WatchOutput = z.infer<typeof WatchOutput>;

export const AgentCard = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  trigger: z.string(),
  internal: z.boolean(),
  /** What a video started now would use. */
  prompt_version: z.string().nullable(),
  model: z.string().nullable(),
  status: z.enum(["ok", "failed", "slow", "idle"]),
  last_run_at: z.string().nullable(),
  /** Its last runs, at most 24, oldest first. */
  recent: z.array(RunStatus),
  open_incidents: z.number(),
});
export type AgentCard = z.infer<typeof AgentCard>;

export const AgentSetting = z.object({ key: z.string(), value: z.unknown(), default: z.unknown(), fixed_at_start: z.boolean(), valid: z.boolean() });
export const AgentInstructions = z.object({
  version: z.string(),
  source: z.enum(["file", "registered", "registered over the file"]),
  model: z.string(),
  in_use: z.boolean(),
  /** False for a version the settings name but nobody has written. */
  exists: z.boolean(),
});
export const AgentDetail = AgentCard.extend({
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  settings_scope: z.enum(["video", "global"]),
  settings: z.array(AgentSetting),
  instructions: z.array(AgentInstructions),
});
export type AgentDetail = z.infer<typeof AgentDetail>;

/** One run in a list: no input and no output, and one line saying what came of it. */
export const RunSummary = z.object({
  id: z.number(),
  session_id: z.string(),
  session_title: z.string().nullable(),
  prompt_version: z.string(),
  model: z.string(),
  window_t0: z.number(),
  window_t1: z.number(),
  attempt: z.number(),
  latency_ms: z.number(),
  error: z.string().nullable(),
  status: RunStatus,
  result: z.string(),
  created_at: z.string(),
});
export type RunSummary = z.infer<typeof RunSummary>;
