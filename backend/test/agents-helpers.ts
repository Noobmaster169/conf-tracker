import type { LlmCall, Session } from "../src/contracts";
import type { Queryable } from "../src/db";
import type { SessionRunner } from "../src/ingest/session-runner";
import * as calls from "../src/repositories/calls";
import * as sessions from "../src/repositories/sessions";

export const auth = { authorization: "Bearer test-key" };

export const aVideo = (db: Queryable, over: Partial<sessions.NewSession> = {}): Promise<Session> =>
  sessions.create(db, { sourceUrl: "https://www.youtube.com/watch?v=QB5BNdBFujE", sourceFile: null, config: {}, title: "Main Stage", ...over });

/** One stored model call; an ok extract call over (0, 30] unless told otherwise. */
export const aCall = (db: Queryable, sessionId: string, over: Partial<calls.NewCall> = {}): Promise<LlmCall> =>
  calls.insert(db, sessionId, {
    step: "extract", promptVersion: "v5", model: "sonnet", windowT0: 0, windowT1: 30, attempt: 1, input: "the transcript", output: "{}", parsed: {},
    inputTokens: 10, outputTokens: 5, costUsd: 0.01, latencyMs: 9000, error: null, ...over,
  });

export const runnerWith = (busy: string[] = []): SessionRunner => ({
  start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")),
  resumeAll: () => Promise.resolve([]), live: () => busy, busy: () => busy, hold: () => {}, fillGap: () => Promise.resolve(false), pending: () => [], wanted: () => false,
});
