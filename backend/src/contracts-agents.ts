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
