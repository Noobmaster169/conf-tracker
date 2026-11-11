import { CallSummary, LlmCall } from "../contracts";
import type { Queryable } from "../db";

interface SummaryRow {
  id: string;
  session_id: string;
  step: string;
  prompt_version: string;
  model: string;
  window_t0: number;
  window_t1: number;
  attempt: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  error: string | null;
  claim_count: number;
  created_at: Date;
}
interface Row extends SummaryRow {
  input: string;
  output: string | null;
  parsed: unknown;
}

const SUMMARY = `c.id, c.session_id, c.step, c.prompt_version, c.model, c.window_t0, c.window_t1, c.attempt,
  c.input_tokens, c.output_tokens, c.cost_usd, c.latency_ms, c.error, c.created_at,
  (select count(*) from claims where claims.call_id = c.id)::int as claim_count`;
const FULL = `${SUMMARY}, c.input, c.output, c.parsed`;

// bigserial comes back as a string from pg.
const toSummaryRow = (row: SummaryRow): CallSummary => CallSummary.parse({ ...row, id: Number(row.id), created_at: row.created_at.toISOString() });
const toCall = (row: Row): LlmCall => LlmCall.parse({ ...row, id: Number(row.id), created_at: row.created_at.toISOString() });

export interface NewCall {
  /** The talk a summarize call was written for; absent on every other step. */
  talkId?: number | null;
  step: string;
  promptVersion: string;
  model: string;
  windowT0: number;
  windowT1: number;
  attempt: number;
  input: string;
  output: string | null;
  parsed: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  error: string | null;
}

export async function insert(db: Queryable, sessionId: string, input: NewCall): Promise<LlmCall> {
  const { rows } = await db.query<Row>(
    `with c as (
       insert into llm_calls (session_id, step, prompt_version, model, window_t0, window_t1, attempt, input, output, parsed,
                              input_tokens, output_tokens, cost_usd, latency_ms, error, talk_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       returning *
     ) select ${FULL} from c`,
    [
      sessionId, input.step, input.promptVersion, input.model, input.windowT0, input.windowT1, input.attempt, input.input, input.output,
      input.parsed === null || input.parsed === undefined ? null : JSON.stringify(input.parsed),
      input.inputTokens, input.outputTokens, input.costUsd, input.latencyMs, input.error, input.talkId ?? null,
    ],
  );
  return toCall(rows[0]!);
}

export async function get(db: Queryable, id: number): Promise<LlmCall | null> {
  const { rows } = await db.query<Row>(`select ${FULL} from llm_calls c where c.id = $1`, [id]);
  return rows[0] ? toCall(rows[0]) : null;
}

/** The last `n` calls of a session, oldest first, so the feed's head is the newest. */
export async function latest(db: Queryable, sessionId: string, n: number): Promise<CallSummary[]> {
  const { rows } = await db.query<SummaryRow>(
    `select * from (select ${SUMMARY} from llm_calls c where c.session_id = $1 order by c.id desc limit $2) recent order by id asc`,
    [sessionId, n],
  );
  return rows.map(toSummaryRow);
}

/** The summary of a call just inserted, with the claim count the caller knows and the row does not yet. */
export function toSummary(call: LlmCall, claimCount: number = call.claim_count): CallSummary {
  const { input: _input, output: _output, parsed: _parsed, ...summary } = call;
  return { ...summary, claim_count: claimCount };
}

/** What a session's calls cost so far, as the proxy reports it; a failed call has no cost and adds nothing. */
export async function totalCost(db: Queryable, sessionId: string, upToId: number = Number.MAX_SAFE_INTEGER): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    `select coalesce(sum(cost_usd), 0)::float8 as total from llm_calls where session_id = $1 and id <= $2`,
    [sessionId, upToId],
  );
  return rows[0]?.total ?? 0;
}

/** Where a step's answered windows reach: the furthest window_t1 of its calls that did not fail, 0 when none did. */
export async function lastAnsweredWindow(db: Queryable, sessionId: string, step: "extract"): Promise<number> {
  const { rows } = await db.query<{ t1: number }>(
    `select coalesce(max(window_t1), 0)::float8 as t1 from llm_calls where session_id = $1 and step = $2 and error is null`,
    [sessionId, step],
  );
  return rows[0]?.t1 ?? 0;
}

/** The furthest answered extract window ending inside (t0, t1]: how far a gap's own extraction got. t0 when none did. */
export async function answeredWithin(db: Queryable, sessionId: string, t0: number, t1: number): Promise<number> {
  const { rows } = await db.query<{ t1: number | null }>(
    `select max(window_t1)::float8 as t1 from llm_calls
      where session_id = $1 and step = 'extract' and error is null and window_t1 > $2 and window_t1 <= $3`,
    [sessionId, t0, t1],
  );
  return rows[0]?.t1 ?? t0;
}
