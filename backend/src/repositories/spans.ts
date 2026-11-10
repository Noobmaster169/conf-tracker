import { Span, type SpanState } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  session_id: string;
  talk_id: string | null;
  state: string;
  t0: number;
  t1: number | null;
  confidence: number | null;
  source: string;
}

const COLUMNS = "id, session_id, talk_id, state, t0, t1, confidence, source";
// bigserial and bigint come back as strings from pg.
const toSpan = (row: Row): Span => Span.parse({ ...row, id: Number(row.id), talk_id: row.talk_id === null ? null : Number(row.talk_id) });

export async function list(db: Queryable, sessionId: string): Promise<Span[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from talk_spans where session_id = $1 order by t0 asc, id asc`, [sessionId]);
  return rows.map(toSpan);
}

/** What is on stage now: the span still running, if any. */
export async function open(db: Queryable, sessionId: string): Promise<Span | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from talk_spans where session_id = $1 and t1 is null order by id desc limit 1`, [sessionId]);
  return rows[0] ? toSpan(rows[0]) : null;
}

/**
 * What was on stage at stream time t: the last span that had started by then. A run over an earlier window must not
 * read today's belief, because on a fast catch-up the tracker is minutes of stream time ahead of the other loops.
 */
export async function at(db: Queryable, sessionId: string, t: number): Promise<Span | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from talk_spans where session_id = $1 and t0 <= $2 order by t0 desc, id desc limit 1`, [sessionId, t]);
  return rows[0] ? toSpan(rows[0]) : null;
}

export interface NewSpan {
  talkId: number | null;
  state: SpanState;
  t: number;
  confidence: number | null;
  quote: string | null;
  source: "tracker" | "admin";
  callId: number | null;
}

export interface Switched {
  /** The span the switch ended, as it reads now. Null when nothing was running or the running one was rewritten. */
  closed: Span | null;
  opened: Span;
}

/**
 * Something else is on stage from t. The running span ends there and a new one starts; when t is at or before the
 * running span's start, that span never really ran, so it is rewritten instead of leaving an empty one behind.
 */
export async function switchTo(db: Queryable, sessionId: string, input: NewSpan): Promise<Switched> {
  const running = await open(db, sessionId);
  const values = [input.talkId, input.state, input.confidence, input.quote, input.source, input.callId];
  if (running && input.t <= running.t0) {
    const { rows } = await db.query<Row>(
      `update talk_spans set talk_id = $2, state = $3, confidence = $4, quote = $5, source = $6, call_id = $7 where id = $1 returning ${COLUMNS}`,
      [running.id, ...values],
    );
    return { closed: null, opened: toSpan(rows[0]!) };
  }
  const closed = running ? await close(db, sessionId, input.t) : null;
  const { rows } = await db.query<Row>(
    `insert into talk_spans (session_id, t0, talk_id, state, confidence, quote, source, call_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLUMNS}`,
    [sessionId, input.t, ...values],
  );
  return { closed, opened: toSpan(rows[0]!) };
}

/** Ends the running span at t (never before its own start). Null when nothing was running. */
export async function close(db: Queryable, sessionId: string, t: number): Promise<Span | null> {
  const { rows } = await db.query<Row>(
    `update talk_spans set t1 = greatest($2, t0) where session_id = $1 and t1 is null returning ${COLUMNS}`,
    [sessionId, t],
  );
  return rows[0] ? toSpan(rows[0]) : null;
}

/** Every stretch of a video in which a talk was on stage, oldest first. */
export async function forTalk(db: Queryable, sessionId: string, talkId: number): Promise<Span[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from talk_spans where session_id = $1 and talk_id = $2 and state = 'talk' order by t0 asc, id asc`,
    [sessionId, talkId],
  );
  return rows.map(toSpan);
}
