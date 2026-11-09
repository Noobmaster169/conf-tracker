import type { Queryable } from "../db";

export interface StoredEvent {
  seq: number;
  type: string;
  payload: unknown;
  received_at: string;
}

export async function append(db: Queryable, sessionId: string, seq: number, type: string, payload: unknown): Promise<void> {
  await db.query("insert into events (session_id, seq, type, payload) values ($1, $2, $3, $4)", [
    sessionId,
    seq,
    type,
    JSON.stringify(payload),
  ]);
}

export async function list(db: Queryable, sessionId: string): Promise<StoredEvent[]> {
  const { rows } = await db.query<{ seq: number; type: string; payload: unknown; received_at: Date }>(
    "select seq, type, payload, received_at from events where session_id = $1 order by seq asc",
    [sessionId],
  );
  return rows.map((row) => ({ ...row, received_at: row.received_at.toISOString() }));
}

export async function maxSeq(db: Queryable, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ max: number }>("select coalesce(max(seq), 0) as max from events where session_id = $1", [sessionId]);
  return Number(rows[0]?.max ?? 0);
}
