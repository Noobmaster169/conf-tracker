import { Segment, type Word } from "../contracts";
import type { Queryable } from "../db";
import { TerminalError } from "../lib/errors";

interface Row {
  id: string;
  session_id: string;
  t0: number;
  t1: number;
  text: string;
  words: Word[];
}

const COLUMNS = "id, session_id, t0, t1, text, words";

function toSegment(row: Row): Segment {
  // bigserial comes back as a string from pg.
  return Segment.parse({ ...row, id: Number(row.id) });
}

export interface NewSegment {
  t0: number;
  t1: number;
  text: string;
  words: Word[];
}

export async function insert(db: Queryable, sessionId: string, input: NewSegment): Promise<Segment> {
  const { rows } = await db.query<Row>(
    `insert into segments (session_id, t0, t1, text, words) values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [sessionId, input.t0, input.t1, input.text, JSON.stringify(input.words)],
  );
  return toSegment(rows[0]!);
}

export async function list(db: Queryable, sessionId: string, range: { from?: number; to?: number; limit?: number }): Promise<Segment[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from segments
     where session_id = $1 and t0 >= $2 and t0 <= $3
     order by t0 asc limit $4`,
    [sessionId, range.from ?? 0, range.to ?? Number.MAX_SAFE_INTEGER, range.limit ?? 1000],
  );
  return rows.map(toSegment);
}

export async function latest(db: Queryable, sessionId: string, n: number): Promise<Segment[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from (
       select ${COLUMNS} from segments where session_id = $1 order by t0 desc limit $2
     ) recent order by t0 asc`,
    [sessionId, n],
  );
  return rows.map(toSegment);
}

/** The newest segment that has ended by upTo: what a stream-time run treats as "now". */
export async function lastUpTo(db: Queryable, sessionId: string, upTo: number): Promise<Segment | null> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from segments where session_id = $1 and t1 <= $2 order by t0 desc limit 1`,
    [sessionId, Number.isFinite(upTo) ? upTo : Number.MAX_SAFE_INTEGER],
  );
  return rows[0] ? toSegment(rows[0]) : null;
}

export async function overlapping(db: Queryable, sessionId: string, from: number, to: number): Promise<Segment[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from segments where session_id = $1 and t1 > $2 and t0 < $3 order by t0 asc`,
    [sessionId, from, to],
  );
  return rows.map(toSegment);
}

export async function updateWords(db: Queryable, id: number, words: Word[]): Promise<Segment> {
  const { rows } = await db.query<Row>(`update segments set words = $2 where id = $1 returning ${COLUMNS}`, [id, JSON.stringify(words)]);
  if (!rows[0]) throw new TerminalError(`segment ${id} not found`);
  return toSegment(rows[0]);
}
