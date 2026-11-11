import type { z } from "zod";

import { loadPrompt, type Prompt } from "../agents/prompts/registry";
import type { Queryable } from "../db";
import * as sessions from "../repositories/sessions";

/**
 * A running video's settings as they are stored now, not as they were when it started: PATCH /sessions/:id/config
 * changes them under a live loop, which reads them again at the top of every run. Anything unreadable falls back to
 * what the loop started with, so a bad edit can never stop a loop. A loop's interval is the one thing fixed at its start.
 */
export async function liveConfig<T>(db: Queryable, sessionId: string, schema: z.ZodType<T>, initial: T): Promise<T> {
  try {
    const session = await sessions.get(db, sessionId);
    const parsed = session ? schema.safeParse(session.config) : null;
    return parsed?.success ? parsed.data : initial;
  } catch {
    return initial;
  }
}

/** The prompt a run uses: the version the settings name now, or the one the loop started with when that cannot be read. */
export function livePrompt(step: string, version: string, model: string, initial: Prompt): Prompt {
  try {
    return { ...loadPrompt(step, version), model };
  } catch {
    return initial;
  }
}
