import { z } from "zod";

import { Span } from "./conference";
import { pageByT0 } from "./paging";
import { Segment, Session, Snapshot } from "./schemas";
import { BackendError, get, parseAs, refusalMessage, request } from "./transport";

export * from "./schemas";

/** One video (the backend calls it a session): its page's first render, its transcript, and the admin's controls. */

export async function getSnapshot(id: string): Promise<Snapshot | null> {
  const response = await request(`/sessions/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(Snapshot, response, "GET /sessions/:id");
}

/** Every segment of a video, oldest first; the snapshot has only the newest. */
export function getTranscript(id: string): Promise<Segment[]> {
  return pageByT0((from) => get(z.array(Segment), `/sessions/${encodeURIComponent(id)}/transcript?from=${from}`));
}

async function post<T>(schema: z.ZodType<T>, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const response = await request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(schema, response, `POST ${path}`);
}

export function createSession(url: string, stageId: string | null): Promise<Session> {
  return post(Session, "/sessions", { url, ...(stageId ? { stage_id: stageId } : {}) });
}

export function stopSession(id: string): Promise<Session> {
  return post(Session, `/sessions/${encodeURIComponent(id)}/stop`);
}

/** Picks a degraded or stopped video up again from where its transcript ends. 409 means it is already running. */
export function resumeSession(id: string): Promise<Session> {
  return post(Session, `/sessions/${encodeURIComponent(id)}/resume`);
}

export function setSessionStage(id: string, stageId: string | null): Promise<Session> {
  return post(Session, `/sessions/${encodeURIComponent(id)}/stage`, { stage_id: stageId });
}

/** The admin's correction: this talk (or a break, with null) is on stage from the newest transcript line. */
export function setNowOnStage(id: string, talkId: number | null): Promise<Span> {
  return post(Span, `/sessions/${encodeURIComponent(id)}/now`, { talk_id: talkId });
}

/** The SSE stream, unread: the route handler hands the body to the browser. */
export function streamEvents(id: string, after: number | null, signal: AbortSignal): Promise<Response> {
  const query = after === null ? "" : `?after=${after}`;
  return request(`/sessions/${encodeURIComponent(id)}/events${query}`, { signal, timeoutMs: 24 * 60 * 60 * 1000 });
}
