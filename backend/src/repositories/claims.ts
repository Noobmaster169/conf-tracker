import { Claim, type ClaimKind, type ClaimStatus, type Polarity, TopicCount } from "../contracts";
import type { Queryable } from "../db";

export interface Row {
  id: string;
  session_id: string;
  call_id: string;
  speaker_id: string | null;
  t0: number | null;
  t1: number | null;
  claim: string;
  topics: string[];
  polarity: string;
  quote: string;
  quote_verified: boolean;
  status: string;
  kind: string | null;
  importance: number | null;
  created_at: Date;
}

export const COLUMNS = "id, session_id, call_id, speaker_id, t0, t1, claim, topics, polarity, quote, quote_verified, status, kind, importance, created_at";
// bigserial and bigint come back as strings from pg.
export const toClaim = (row: Row): Claim => Claim.parse({ ...row, id: Number(row.id), call_id: Number(row.call_id), created_at: row.created_at.toISOString() });

export interface NewClaim {
  speakerId: string | null;
  t0: number | null;
  t1: number | null;
  claim: string;
  topics: string[];
  polarity: Polarity;
  quote: string;
  quoteVerified: boolean;
  status: ClaimStatus;
  kind?: ClaimKind | null;
  importance?: number | null;
}

/** Stores the claims of one call in the order the model gave them; ids follow that order. */
export async function insertMany(db: Queryable, sessionId: string, callId: number, items: NewClaim[]): Promise<Claim[]> {
  const stored: Claim[] = [];
  for (const item of items) {
    const { rows } = await db.query<Row>(
      `insert into claims (session_id, call_id, speaker_id, t0, t1, claim, topics, polarity, quote, quote_verified, status, kind, importance)
       values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13) returning ${COLUMNS}`,
      [sessionId, callId, item.speakerId, item.t0, item.t1, item.claim, item.topics, item.polarity, item.quote, item.quoteVerified, item.status, item.kind ?? null, item.importance ?? null],
    );
    stored.push(toClaim(rows[0]!));
  }
  return stored;
}

/** Claims by stream time. An unverified claim has no time and is always included: hiding it would hide a failure. */
export async function list(db: Queryable, sessionId: string, range: { from?: number; to?: number; limit?: number }): Promise<Claim[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from claims
     where session_id = $1 and (t0 is null or (t0 >= $2 and t0 <= $3))
     order by id asc limit $4`,
    [sessionId, range.from ?? 0, range.to ?? Number.MAX_SAFE_INTEGER, range.limit ?? 1000],
  );
  return rows.map(toClaim);
}

/** The last `n` claims, oldest first. */
export async function latest(db: Queryable, sessionId: string, n: number): Promise<Claim[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from (select ${COLUMNS} from claims where session_id = $1 order by id desc limit $2) recent order by id asc`,
    [sessionId, n],
  );
  return rows.map(toClaim);
}

export async function forCall(db: Queryable, callId: number): Promise<Claim[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from claims where call_id = $1 order by id asc`, [callId]);
  return rows.map(toClaim);
}

/**
 * How often each topic came up among the claims timed in a range. Duplicates would count one assertion twice, and an
 * unverified claim has no time, so neither counts; the feed still lists both.
 */
export async function topicCounts(db: Queryable, sessionId: string, range: { from: number; to: number; limit?: number }): Promise<TopicCount[]> {
  const { rows } = await db.query<{ topic: string; count: number }>(
    `select lower(topic) as topic, count(*)::int as count
     from claims, unnest(topics) as topic
     where session_id = $1 and status <> 'duplicate' and t0 >= $2 and t0 <= $3
     group by lower(topic) order by count desc, topic asc limit $4`,
    [sessionId, range.from, range.to, range.limit ?? 20],
  );
  return rows.map((row) => TopicCount.parse(row));
}

export async function get(db: Queryable, id: number): Promise<Claim | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from claims where id = $1`, [id]);
  return rows[0] ? toClaim(rows[0]) : null;
}

export interface ClaimChange {
  claim?: string;
  kind?: ClaimKind;
  importance?: number;
  topics?: string[];
  polarity?: Polarity;
  speaker_id?: string | null;
}

const CHANGEABLE = ["claim", "kind", "importance", "topics", "polarity", "speaker_id"] as const;

/** A correction by hand: only the fields given change. The quote, its time and the call that produced the claim stay as they were. */
export async function change(db: Queryable, id: number, input: ClaimChange): Promise<Claim | null> {
  const fields = CHANGEABLE.filter((field) => input[field] !== undefined);
  if (fields.length === 0) return get(db, id);
  const sets = fields.map((field, i) => `${field} = $${i + 2}${field === "topics" ? "::text[]" : ""}`);
  const { rows } = await db.query<Row>(`update claims set ${sets.join(", ")} where id = $1 returning ${COLUMNS}`, [id, ...fields.map((field) => input[field])]);
  return rows[0] ? toClaim(rows[0]) : null;
}

/** Takes a claim out for good. False when there is no such claim. */
export async function remove(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query("delete from claims where id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * The `limit` claims placed nearest to [from, to] (by t0, at most `margin` seconds outside it), oldest first: what a
 * window of a stretch extracted after the fact is deduped against, its neighbours on both sides.
 */
export async function around(db: Queryable, sessionId: string, from: number, to: number, margin: number, limit: number): Promise<Claim[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from (
       select ${COLUMNS} from claims
        where session_id = $1 and t0 is not null and t0 >= $2::float8 - $4::float8 and t0 <= $3::float8 + $4::float8
        order by greatest(0, $2::float8 - t0, t0 - $3::float8) asc, id desc limit $5
     ) near order by t0 asc, id asc`,
    [sessionId, from, to, margin, limit],
  );
  return rows.map(toClaim);
}
