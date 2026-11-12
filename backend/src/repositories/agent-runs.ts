import { type CallEffects, NO_EFFECTS } from "../agents/agent";
import type { RunStatus } from "../contracts-agents";
import type { Queryable } from "../db";

/**
 * An agent's calls read as runs. Every attempt is its own row in llm_calls, so a run that failed, was corrected and
 * succeeded is two rows; what a person counts is the run, which is its last attempt. Nothing here returns a call's
 * input or output: a list of runs must stay small whatever the calls held.
 */
export interface RunRow {
  id: number;
  session_id: string;
  session_title: string | null;
  step: string;
  prompt_version: string;
  model: string;
  window_t0: number;
  window_t1: number;
  attempt: number;
  latency_ms: number;
  error: string | null;
  parsed: unknown;
  created_at: string;
}

interface DbRow extends Omit<RunRow, "id" | "created_at"> {
  id: string;
  created_at: Date;
}

const SAME_RUN_KEY = (a: string, b: string) => `${a}.session_id = ${b}.session_id and ${a}.step = ${b}.step and ${a}.window_t0 = ${b}.window_t0 and ${a}.window_t1 = ${b}.window_t1`;

/** True of a row no later attempt follows: the next row over the same window, if any, is not this one's retry. */
const LAST_ATTEMPT = `not exists (
  select 1 from llm_calls n
   where ${SAME_RUN_KEY("n", "c")} and n.attempt = c.attempt + 1
     and n.id = (select min(m.id) from llm_calls m where ${SAME_RUN_KEY("m", "c")} and m.id > c.id))`;

const COLUMNS = `c.id, c.session_id, s.title as session_title, c.step, c.prompt_version, c.model, c.window_t0, c.window_t1, c.attempt, c.latency_ms, c.error, c.parsed, c.created_at`;

const toRun = (row: DbRow): RunRow => ({ ...row, id: Number(row.id), created_at: row.created_at.toISOString() });

/** Failed beats slow: a run that errored after two minutes failed. */
export function statusOf(run: { error: string | null; latency_ms: number }, slowMs: number): RunStatus {
  return run.error !== null ? "failed" : run.latency_ms > slowMs ? "slow" : "ok";
}

export interface ListRuns {
  agentId: string;
  sessionId?: string;
  status?: "failed" | "slow";
  /** Runs older than this call id. */
  before?: number;
  limit: number;
  slowMs: number;
}

/** An agent's runs, newest first. */
export async function listRuns(db: Queryable, opts: ListRuns): Promise<RunRow[]> {
  const where = ["c.step = $1", LAST_ATTEMPT];
  const values: unknown[] = [opts.agentId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  if (opts.sessionId) add("c.session_id = ?", opts.sessionId);
  if (opts.before) add("c.id < ?", opts.before);
  if (opts.status === "failed") where.push("c.error is not null");
  if (opts.status === "slow") add("c.error is null and c.latency_ms > ?", opts.slowMs);
  values.push(opts.limit);
  const { rows } = await db.query<DbRow>(
    `select ${COLUMNS} from llm_calls c join sessions s on s.id = c.session_id where ${where.join(" and ")} order by c.id desc limit $${values.length}`,
    values,
  );
  return rows.map(toRun);
}

/** How an agent's last `n` runs went, oldest first; empty for one that never ran. */
export async function recentStatuses(db: Queryable, agentId: string, n: number, slowMs: number): Promise<{ status: RunStatus; at: string }[]> {
  const { rows } = await db.query<{ error: string | null; latency_ms: number; created_at: Date }>(
    `select c.error, c.latency_ms, c.created_at from llm_calls c where c.step = $1 and ${LAST_ATTEMPT} order by c.id desc limit $2`,
    [agentId, n],
  );
  return rows.reverse().map((row) => ({ status: statusOf(row, slowMs), at: row.created_at.toISOString() }));
}

/** What each of these calls caused, one query per kind of effect for the whole list. */
export async function effectsFor(db: Queryable, callIds: number[]): Promise<Map<number, CallEffects>> {
  const effects = new Map<number, CallEffects>(callIds.map((id) => [id, { ...NO_EFFECTS, named: [] }]));
  if (callIds.length === 0) return effects;
  const at = (id: string): CallEffects => effects.get(Number(id))!;
  const [claimRows, nameRows, spanRows, summaryRows] = await Promise.all([
    db.query<{ call_id: string; n: number }>(`select call_id, count(*)::int as n from claims where call_id = any($1::bigint[]) group by call_id`, [callIds]),
    db.query<{ call_id: string; speaker_id: string; name: string }>(
      `select call_id, speaker_id, name from name_proposals where call_id = any($1::bigint[]) and status = 'accepted' order by id`,
      [callIds],
    ),
    db.query<{ call_id: string; title: string | null }>(
      `select p.call_id, t.title from talk_spans p left join talks t on t.id = p.talk_id where p.call_id = any($1::bigint[]) and p.state = 'talk' order by p.id`,
      [callIds],
    ),
    db.query<{ call_id: string; title: string }>(
      `select m.call_id, t.title from talk_summaries m join talks t on t.id = m.talk_id where m.call_id = any($1::bigint[])`,
      [callIds],
    ),
  ]);
  for (const row of claimRows.rows) at(row.call_id).claims = row.n;
  for (const row of nameRows.rows) at(row.call_id).named.push({ voice: row.speaker_id, name: row.name });
  for (const row of spanRows.rows) at(row.call_id).switchedTo = row.title;
  for (const row of summaryRows.rows) at(row.call_id).summaryOf = row.title;
  return effects;
}

/** The ids of every attempt of the run this call belongs to, oldest first. */
export async function attemptsOf(db: Queryable, callId: number): Promise<number[]> {
  const { rows } = await db.query<{ id: string; attempt: number }>(
    `select n.id, n.attempt from llm_calls n join llm_calls c on c.id = $1 and ${SAME_RUN_KEY("n", "c")} order by n.id`,
    [callId],
  );
  // The same window may have been run more than once; a run is a stretch of rows whose attempts count up by one.
  const index = rows.findIndex((row) => Number(row.id) === callId);
  if (index < 0) return [];
  let start = index;
  while (start > 0 && rows[start]!.attempt === rows[start - 1]!.attempt + 1) start--;
  let end = index;
  while (end < rows.length - 1 && rows[end + 1]!.attempt === rows[end]!.attempt + 1) end++;
  return rows.slice(start, end + 1).map((row) => Number(row.id));
}
