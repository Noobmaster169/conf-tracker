import type { Queryable } from "../db";

/** One summarize (or post) model call per talk and video in this time, and none after MAX_SUMMARY_FAILS failed ones. */
const SUMMARY_BACKOFF_MS = 60 * 60 * 1000;
const MAX_SUMMARY_FAILS = 5;

export type SummaryAllowance = "allowed" | "wait" | "given_up";

/**
 * Whether a background summary of this talk may call the model now: never after five failures (given up), and at
 * most once an hour (wait). With `failuresOnly` (a summary written again because its talk changed) only a failed call
 * starts the hour: a talk whose summary was just written fine may be written again, a broken one is not hammered.
 */
export async function summaryAllowance(
  db: Queryable,
  sessionId: string,
  talkId: number,
  nowMs: number,
  opts: { failuresOnly?: boolean; step?: "summarize" | "post" } = {},
): Promise<SummaryAllowance> {
  const { rows } = await db.query<{ fails: string; last: Date | null; last_fail: Date | null }>(
    `select count(*) filter (where error is not null) as fails, max(created_at) as last,
            max(created_at) filter (where error is not null) as last_fail
       from llm_calls where session_id = $1 and step = $3 and talk_id = $2`,
    [sessionId, talkId, opts.step ?? "summarize"],
  );
  const row = rows[0];
  if (!row) return "allowed";
  if (Number(row.fails) >= MAX_SUMMARY_FAILS) return "given_up";
  const last = opts.failuresOnly ? row.last_fail : row.last;
  return !last || last.getTime() <= nowMs - SUMMARY_BACKOFF_MS ? "allowed" : "wait";
}

export async function summaryAllowed(
  db: Queryable,
  sessionId: string,
  talkId: number,
  nowMs: number,
  opts: { failuresOnly?: boolean; step?: "summarize" | "post" } = {},
): Promise<boolean> {
  return (await summaryAllowance(db, sessionId, talkId, nowMs, opts)) === "allowed";
}
