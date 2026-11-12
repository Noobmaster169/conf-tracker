import { z } from "zod";

import { ActivityLine, AgentCard, AgentDetail, CallWindow, Incident, OpsStatus, PromptText, Rerun, RunSummary, SettingsResult } from "./agent-schemas";
import { BackendError, get, parseAs, refusalMessage, request } from "./transport";

export * from "./agent-schemas";

/** The agents: who they are, how each is doing, what each did. */

async function getOrNull<T>(schema: z.ZodType<T>, path: string, what: string): Promise<T | null> {
  const response = await request(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(schema, response, what);
}

export function listAgents(): Promise<AgentCard[]> {
  return get(z.array(AgentCard), "/agents");
}

export function getAgent(id: string): Promise<AgentDetail | null> {
  return getOrNull(AgentDetail, `/agents/${encodeURIComponent(id)}`, "GET /agents/:id");
}

export interface CallsFilter {
  session?: string;
  status?: "failed" | "slow";
  before?: number;
  limit?: number;
}

export function listAgentCalls(id: string, filter: CallsFilter = {}): Promise<RunSummary[]> {
  const query = new URLSearchParams();
  if (filter.session) query.set("session", filter.session);
  if (filter.status) query.set("status", filter.status);
  if (filter.before) query.set("before", String(filter.before));
  if (filter.limit) query.set("limit", String(filter.limit));
  return get(z.array(RunSummary), `/agents/${encodeURIComponent(id)}/calls?${query}`);
}

export function getCall(id: number): Promise<CallWindow | null> {
  return getOrNull(CallWindow, `/calls/${id}`, "GET /calls/:id");
}

export function getOpsStatus(): Promise<OpsStatus> {
  return get(OpsStatus, "/ops/status");
}

/** A write made from Admin says so, so the record of changes can name who made it. */
async function send<T>(schema: z.ZodType<T>, method: "POST" | "PUT" | "PATCH", path: string, body: unknown = {}, timeoutMs = 30_000): Promise<T> {
  const response = await request(path, { method, body: JSON.stringify(body), timeoutMs, headers: { "x-actor": "admin" } });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(schema, response, `${method} ${path}`);
}

export function listIncidents(filter: { open?: boolean; agent?: string; limit?: number } = {}): Promise<Incident[]> {
  const query = new URLSearchParams();
  if (filter.open) query.set("open", "1");
  if (filter.agent) query.set("agent", filter.agent);
  if (filter.limit) query.set("limit", String(filter.limit));
  return get(z.array(Incident), `/incidents?${query}`);
}

export function resolveIncident(id: number): Promise<Incident> {
  return send(Incident, "POST", `/incidents/${id}/resolve`);
}

export function listActivity(id: string, filter: { before?: string; limit?: number } = {}): Promise<ActivityLine[]> {
  const query = new URLSearchParams();
  if (filter.before) query.set("before", filter.before);
  if (filter.limit) query.set("limit", String(filter.limit));
  return get(z.array(ActivityLine), `/agents/${encodeURIComponent(id)}/activity?${query}`);
}

export function getPrompt(step: string, version: string): Promise<PromptText | null> {
  return getOrNull(PromptText, `/ops/prompts/${encodeURIComponent(step)}/${encodeURIComponent(version)}`, "GET /ops/prompts/:step/:version");
}

export function putPrompt(step: string, version: string, body: { text: string; model?: string }): Promise<PromptText> {
  return send(PromptText, "PUT", `/ops/prompts/${encodeURIComponent(step)}/${encodeURIComponent(version)}`, body);
}

export type Apply = "all" | "new" | "running";

export function patchSettings(id: string, set: Record<string, unknown>, apply: Apply): Promise<SettingsResult> {
  return send(SettingsResult, "PATCH", `/agents/${encodeURIComponent(id)}/settings`, { set, apply });
}

export function startRerun(callId: number, body: { prompt_version?: string; model?: string }): Promise<Rerun> {
  return send(Rerun, "POST", `/calls/${callId}/rerun`, body);
}

export function getRerun(id: number): Promise<Rerun | null> {
  return getOrNull(Rerun, `/reruns/${id}`, "GET /reruns/:id");
}
