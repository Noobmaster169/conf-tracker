import { Leg } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  session_id: string;
  speech_id: string;
  kind: string;
  requested_t: number;
  start_t: number | null;
  end_t: number | null;
  opened_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

const COLUMNS = "id, session_id, speech_id, kind, requested_t, start_t, end_t, opened_at, ended_at, end_reason";

// bigserial comes back as text; ids are small enough to be numbers.
const toLeg = (row: Row): Leg =>
  Leg.parse({ ...row, id: Number(row.id), opened_at: row.opened_at.toISOString(), ended_at: row.ended_at?.toISOString() ?? null });

/** A leg is one connection to speech, asked to start at requestedT stream seconds. */
export async function open(db: Queryable, sessionId: string, input: { speechId: string; kind: "main" | "gap"; requestedT: number }): Promise<Leg> {
  const { rows } = await db.query<Row>(
    `insert into session_legs (session_id, speech_id, kind, requested_t) values ($1, $2, $3, $4) returning ${COLUMNS}`,
    [sessionId, input.speechId, input.kind, input.requestedT],
  );
  return toLeg(rows[0]!);
}

/** The second speech actually started at (the request rounded down to a frame). */
export async function started(db: Queryable, legId: number, startT: number): Promise<void> {
  await db.query("update session_legs set start_t = $2 where id = $1", [legId, startT]);
}

export async function ended(db: Queryable, legId: number, input: { endT: number; reason: string }): Promise<void> {
  await db.query("update session_legs set end_t = $2, end_reason = $3, ended_at = now() where id = $1", [legId, input.endT, input.reason]);
}

/** Ends the video's legs still open (a process that held them died): at the end of what is stored, never before its start. */
export async function endOpen(db: Queryable, sessionId: string, reason: string): Promise<number> {
  const { rowCount } = await db.query(
    `update session_legs set end_reason = $2, ended_at = now(),
       end_t = greatest(coalesce(start_t, requested_t), coalesce((select max(t1) from segments where session_id = $1), 0))
     where session_id = $1 and ended_at is null`,
    [sessionId, reason],
  );
  return rowCount ?? 0;
}

export async function latest(db: Queryable, sessionId: string): Promise<Leg | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from session_legs where session_id = $1 order by id desc limit 1`, [sessionId]);
  return rows[0] ? toLeg(rows[0]) : null;
}
