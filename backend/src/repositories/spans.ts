import { Span, type SpanState } from "../contracts";
import { atomic, type Queryable } from "../db";

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

/** Closed talk spans whose talk has no summary for that video yet, in videos created within `days`. One pair per talk and video. */
export async function unsummarised(db: Queryable, days = 7): Promise<{ sessionId: string; talkId: number }[]> {
  const { rows } = await db.query<{ session_id: string; talk_id: string }>(
    `select distinct sp.session_id, sp.talk_id
       from talk_spans sp
       join sessions s on s.id = sp.session_id
      where sp.state = 'talk' and sp.talk_id is not null and sp.t1 is not null
        and s.created_at > now() - make_interval(days => $1::int)
        and not exists (select 1 from talk_summaries ts where ts.talk_id = sp.talk_id and ts.session_id = sp.session_id)
      order by sp.session_id, sp.talk_id`,
    [days],
  );
  return rows.map((r) => ({ sessionId: r.session_id, talkId: Number(r.talk_id) }));
}

export interface RangeSpan {
  talkId: number | null;
  state: SpanState;
  t0: number;
  t1: number;
}

const sameStage = (span: Span, next: RangeSpan) => span.state === next.state && (span.state !== "talk" || span.talk_id === next.talkId);

/**
 * What was on stage from t0 to t1 is `next` (in order, inside [t0, t1]). The spans reaching into the range are trimmed
 * to its edges, one running across it is split in two, and the ones inside it are dropped; the new ones are inserted
 * (source tracker), joined to the span either side when it is the same talk, so a talk that went on is still one span.
 */
export async function rewriteRange(db: Queryable, sessionId: string, t0: number, t1: number, next: RangeSpan[]): Promise<void> {
  await atomic(db, (tx) => rewrite(tx, sessionId, t0, t1, next));
}

async function rewrite(db: Queryable, sessionId: string, t0: number, t1: number, next: RangeSpan[]): Promise<void> {
  const all = await list(db, sessionId);
  const overlapping = all.filter((s) => s.t0 < t1 && (s.t1 === null || s.t1 > t0));
  // A span ending exactly at t0, or starting exactly at t1, is a neighbour too: the new ones may join it.
  let before: Span | null = all.find((s) => s.t1 === t0 && s.t0 < t0) ?? null;
  let after: Span | null = all.find((s) => s.t0 === t1 && (s.t1 === null || s.t1 > t1)) ?? null;
  for (const span of overlapping) {
    const startsBefore = span.t0 < t0;
    const endsAfter = span.t1 === null || span.t1 > t1;
    if (startsBefore && endsAfter) {
      // Split: the part after the range is a copy of the span, starting at t1.
      const { rows } = await db.query<Row>(
        `insert into talk_spans (session_id, t0, t1, talk_id, state, confidence, quote, source, call_id)
         select session_id, $2, t1, talk_id, state, confidence, quote, source, call_id from talk_spans where id = $1 returning ${COLUMNS}`,
        [span.id, t1],
      );
      after = toSpan(rows[0]!);
      before = toSpan((await db.query<Row>(`update talk_spans set t1 = $2 where id = $1 returning ${COLUMNS}`, [span.id, t0])).rows[0]!);
    } else if (startsBefore) {
      before = toSpan((await db.query<Row>(`update talk_spans set t1 = $2 where id = $1 returning ${COLUMNS}`, [span.id, t0])).rows[0]!);
    } else if (endsAfter) {
      after = toSpan((await db.query<Row>(`update talk_spans set t0 = $2 where id = $1 returning ${COLUMNS}`, [span.id, t1])).rows[0]!);
    } else {
      await db.query("delete from talk_spans where id = $1", [span.id]);
    }
  }
  for (const [i, span] of next.entries()) {
    if (span.t1 <= span.t0) continue;
    if (i === 0 && before && span.t0 === t0 && sameStage(before, span)) {
      const bridges = next.length === 1 && after !== null && span.t1 === t1 && sameStage(after, span);
      // One talk all the way across: the split is undone.
      if (bridges) await db.query("delete from talk_spans where id = $1", [after!.id]);
      await db.query("update talk_spans set t1 = $2 where id = $1", [before.id, bridges ? after!.t1 : span.t1]);
      continue;
    }
    if (i === next.length - 1 && after && span.t1 === t1 && sameStage(after, span)) {
      await db.query("update talk_spans set t0 = $2 where id = $1", [after.id, span.t0]);
      continue;
    }
    await db.query(
      "insert into talk_spans (session_id, t0, t1, talk_id, state, source) values ($1, $2, $3, $4, $5, 'tracker')",
      [sessionId, span.t0, span.t1, span.talkId, span.state],
    );
  }
}
