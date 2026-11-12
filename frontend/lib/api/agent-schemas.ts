import { z } from "zod";

/** The shapes of the backend's agent routes (backend/src/contracts-agents.ts). No transport here, so tests can import it. */

export const RunStatus = z.enum(["ok", "failed", "slow"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const AgentStatus = z.enum(["ok", "failed", "slow", "idle"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentCard = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  trigger: z.string(),
  internal: z.boolean(),
  prompt_version: z.string().nullable(),
  model: z.string().nullable(),
  status: AgentStatus,
  last_run_at: z.string().nullable(),
  recent: z.array(RunStatus),
  open_incidents: z.number(),
});
export type AgentCard = z.infer<typeof AgentCard>;

export const AgentSetting = z.object({ key: z.string(), value: z.unknown(), default: z.unknown(), fixed_at_start: z.boolean(), valid: z.boolean() });
export type AgentSetting = z.infer<typeof AgentSetting>;

export const AgentInstructions = z.object({ version: z.string(), source: z.string(), model: z.string(), in_use: z.boolean(), exists: z.boolean() });
export type AgentInstructions = z.infer<typeof AgentInstructions>;

export const AgentDetail = AgentCard.extend({
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  settings_scope: z.enum(["video", "global"]),
  settings: z.array(AgentSetting),
  instructions: z.array(AgentInstructions),
});
export type AgentDetail = z.infer<typeof AgentDetail>;

export const RunSummary = z.object({
  id: z.number(),
  session_id: z.string(),
  session_title: z.string().nullable(),
  prompt_version: z.string(),
  model: z.string(),
  attempt: z.number(),
  latency_ms: z.number(),
  error: z.string().nullable(),
  status: RunStatus,
  result: z.string(),
  created_at: z.string(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const FullCall = z.object({
  id: z.number(),
  session_id: z.string(),
  step: z.string(),
  prompt_version: z.string(),
  model: z.string(),
  attempt: z.number(),
  latency_ms: z.number(),
  error: z.string().nullable(),
  input: z.string(),
  output: z.string().nullable(),
  created_at: z.string(),
});
export type FullCall = z.infer<typeof FullCall>;

/** One call opened: GET /calls/:id. */
export const CallWindow = z.object({
  call: FullCall,
  result: z.string(),
  status: RunStatus,
  attempts: z.array(FullCall),
  claims: z.array(z.object({ id: z.number(), claim: z.string(), status: z.string() })),
  proposals: z.array(z.object({ id: z.number(), speaker_id: z.string(), name: z.string(), status: z.string(), reason: z.string().nullable() })),
});
export type CallWindow = z.infer<typeof CallWindow>;

const Probe = z.object({ ok: z.boolean() });
/** The parts of GET /ops/status the Agents overview reads. */
export const OpsStatus = z.object({
  api: z.object({ live: z.array(z.string()) }),
  llm_proxy: Probe,
  speech: Probe,
  box: z
    .object({
      age_s: z.number().nullable(),
      stale: z.boolean(),
      deployed: z.string().nullish(),
      origin_main: z.string().nullish(),
      held_back: z.string().nullish(),
      failed: z.string().nullish(),
    })
    .nullable(),
});
export type OpsStatus = z.infer<typeof OpsStatus>;
