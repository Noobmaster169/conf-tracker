import { z } from "zod";

import { AgentCard, AgentDetail, CallWindow, OpsStatus, RunSummary } from "./agent-schemas";
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
