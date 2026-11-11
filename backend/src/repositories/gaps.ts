import { Gap } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  session_id: string;
  t0: number;
  t1: number;
  filled_at: Date | null;
  created_at: Date;
  note: string | null;
}

const COLUMNS = "id, session_id, t0, t1, filled_at, created_at, note";

const toGap = (row: Row): Gap =>
  Gap.parse({ ...row, id: Number(row.id), filled_at: row.filled_at?.toISOString() ?? null, created_at: row.created_at.toISOString() });

/** A stretch of stream time no leg covered. */
export async function add(db: Queryable, sessionId: string, t0: number, t1: number): Promise<Gap> {
  const { rows } = await db.query<Row>(`insert into session_gaps (session_id, t0, t1) values ($1, $2, $3) returning ${COLUMNS}`, [sessionId, t0, t1]);
  return toGap(rows[0]!);
}

/** The gaps still to fill, earliest first. */
export async function open(db: Queryable, sessionId: string): Promise<Gap[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from session_gaps where session_id = $1 and filled_at is null order by t0, id`, [sessionId]);
  return rows.map(toGap);
}

export async function filled(db: Queryable, gapId: number): Promise<void> {
  await db.query("update session_gaps set filled_at = now() where id = $1", [gapId]);
}

/** Filling was given up: the gap stays open, with why. */
export async function note(db: Queryable, gapId: number, text: string): Promise<void> {
  await db.query("update session_gaps set note = $2 where id = $1", [gapId, text]);
}
