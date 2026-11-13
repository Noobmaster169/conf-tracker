import { z } from "zod";

import { Span } from "./conference";
import { Session } from "./schemas";
import { BackendError, parseAs, refusalMessage, request } from "./transport";

export * from "./schemas";

/** One video (the backend calls it a session): the admin's controls. */

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
