import type { Session } from "../contracts";
import type { Queryable } from "../db";
import { replayConfig } from "../lib/replay-config";
import * as sessions from "../repositories/sessions";
import type { SessionRunner } from "./session-runner";

/** A patch over stored settings: a null value takes the key away, so its default applies again. */
function merge(stored: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = replayConfig(stored, 0, patch);
  delete merged.speed;
  return merged;
}

/** The config new videos start from, with a patch over it. It never holds a speed. */
export const mergeDefault = merge;

/** A video's config with a patch over it. Its speed, if it is a replay, stays what it was: the Speed choice owns it. */
export function mergeSession(config: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = merge(config, patch);
  if ("speed" in config) merged.speed = config.speed;
  return merged;
}

/**
 * The videos a change "for running videos" must reach: every one the runner holds, and every ended one with a gap
 * still to fill, because the gap filler runs the agents again later from that video's stored config.
 */
export async function runningSessions(db: Queryable, runner: SessionRunner): Promise<Session[]> {
  const { rows } = await db.query<{ session_id: string }>(`select distinct session_id from session_gaps where filled_at is null`);
  const ids = [...new Set([...runner.busy(), ...rows.map((row) => row.session_id)])];
  const found = await Promise.all(ids.map((id) => sessions.get(db, id)));
  return found.filter((session): session is Session => session !== null);
}
