import { z } from "zod";

import { ClaimSearch } from "./claim-schemas";
import { pageByRange, pageByT0 } from "./paging";
import { CallDetail, Claim, Segment, Session, Snapshot, SpeakerDetail, Topics } from "./schemas";
import { BackendError, get, parseAs, refusalMessage, request } from "./transport";

export * from "./schemas";

export function listSessions(): Promise<Session[]> {
  return get(z.array(Session), "/sessions");
}

export async function getSnapshot(id: string): Promise<Snapshot | null> {
  const response = await request(`/sessions/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(Snapshot, response, "GET /sessions/:id");
}

/** Every segment of a session, oldest first; the snapshot has only the newest. */
export function getTranscript(id: string): Promise<Segment[]> {
  return pageByT0((from) => get(z.array(Segment), `/sessions/${encodeURIComponent(id)}/transcript?from=${from}`));
}

/** Every claim of a session in id order; the snapshot has only the newest. `endS` is where the stream's times stop. */
export function getClaims(id: string, endS: number): Promise<Claim[]> {
  return pageByRange((from, to) => get(z.array(Claim), `/sessions/${encodeURIComponent(id)}/claims?from=${from}&to=${to}`), endS);
}

export async function getSpeaker(id: string, sid: string): Promise<SpeakerDetail | null> {
  const response = await request(`/sessions/${encodeURIComponent(id)}/speakers/${encodeURIComponent(sid)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(SpeakerDetail, response, "GET /sessions/:id/speakers/:sid");
}

export async function getCall(id: number): Promise<CallDetail | null> {
  const response = await request(`/calls/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(CallDetail, response, "GET /calls/:id");
}

export async function createSession(url: string): Promise<Session> {
  const response = await request("/sessions", { method: "POST", body: JSON.stringify({ url }), timeoutMs: 30_000 });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(Session, response, "POST /sessions");
}

export async function stopSession(id: string): Promise<Session> {
  const response = await request(`/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(Session, response, "POST /sessions/:id/stop");
}

export async function replaySession(id: string, body: { config?: Record<string, unknown>; speed?: number }): Promise<Session> {
  const response = await request(`/sessions/${encodeURIComponent(id)}/replay`, { method: "POST", body: JSON.stringify(body), timeoutMs: 30_000 });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(Session, response, "POST /sessions/:id/replay");
}

/** The SSE stream, unread: the route handler hands the body to the browser. */
export function streamEvents(id: string, after: number | null, signal: AbortSignal): Promise<Response> {
  const query = after === null ? "" : `?after=${after}`;
  return request(`/sessions/${encodeURIComponent(id)}/events${query}`, { signal, timeoutMs: 24 * 60 * 60 * 1000 });
}

export function getTopics(id: string, from: number, to: number): Promise<Topics> {
  return get(Topics, `/sessions/${encodeURIComponent(id)}/topics?from=${from}&to=${to}&limit=10`);
}

/** GET /claims with a query string built by lib/claim-filters.ts. */
export function searchClaims(query: string): Promise<ClaimSearch> {
  return get(ClaimSearch, query ? `/claims?${query}` : "/claims");
}
