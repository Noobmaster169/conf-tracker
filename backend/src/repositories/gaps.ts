import { Gap, type GapStage } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  session_id: string;
  t0: number;
  t1: number;
  filled_at: Date | null;
  created_at: Date;
  note: string | null;
  stage: string | null;
  stage_at: Date | null;
  tried_at: Date | null;
  since: Date | null;
}

const COLUMNS = "id, session_id, t0, t1, filled_at, created_at, note, stage, stage_at, tried_at, since";

const iso = (d: Date | null) => d?.toISOString() ?? null;
const toGap = (row: Row): Gap =>
  Gap.parse({
    ...row, id: Number(row.id), filled_at: iso(row.filled_at), created_at: row.created_at.toISOString(), stage_at: iso(row.stage_at), tried_at: iso(row.tried_at), since: iso(row.since),
  });

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

/** The unfilled gaps of several videos at once, by session. */
export async function openFor(db: Queryable, sessionIds: string[]): Promise<Map<string, Gap[]>> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from session_gaps where session_id = any($1::uuid[]) and filled_at is null order by t0, id`, [sessionIds]);
  const by = new Map<string, Gap[]>();
  for (const row of rows) by.set(row.session_id, [...(by.get(row.session_id) ?? []), toGap(row)]);
  return by;
}

export async function get(db: Queryable, gapId: number): Promise<Gap | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from session_gaps where id = $1`, [gapId]);
  return rows[0] ? toGap(rows[0]) : null;
}

export async function filled(db: Queryable, gapId: number): Promise<void> {
  await db.query("update session_gaps set filled_at = now() where id = $1", [gapId]);
}

/** Filling was given up: the gap stays open, with why. */
export async function note(db: Queryable, gapId: number, text: string): Promise<void> {
  await db.query("update session_gaps set note = $2 where id = $1", [gapId, text]);
}

/** A step of the fill is done: the next try starts after it, with no wait. */
export async function setStage(db: Queryable, gapId: number, stage: GapStage): Promise<void> {
  await db.query("update session_gaps set stage = $2, stage_at = now(), tried_at = null where id = $1", [gapId, stage]);
}

/** A step failed or was refused at `at`: the gap waits before the next try. */
export async function tried(db: Queryable, gapId: number, at: Date): Promise<void> {
  await db.query("update session_gaps set tried_at = $2 where id = $1", [gapId, at]);
}

/** The first try at its transcript, unless one is already recorded. */
export async function startTrying(db: Queryable, gapId: number, at: Date): Promise<void> {
  await db.query("update session_gaps set since = coalesce(since, $2) where id = $1", [gapId, at]);
}

/** The video was resumed by hand: its given-up gaps are tried again, with a fresh day. */
export async function retryNoted(db: Queryable, sessionId: string): Promise<void> {
  await db.query("update session_gaps set note = null, since = null, tried_at = null where session_id = $1 and filled_at is null and note is not null", [sessionId]);
}

/**
 * A leg asked to start at `t` covers everything from there on, by reading it or by recording a gap of its own: of the
 * untouched gaps (no stage yet), those that begin at or after `t` are closed as filled, and one that runs past `t` is cut
 * back to end there (a stop's gap that a preempted gap leg had begun to read, which moved the resume point into it).
 */
export async function supersede(db: Queryable, sessionId: string, t: number): Promise<void> {
  await db.query(
    "update session_gaps set filled_at = now() where session_id = $1 and filled_at is null and stage is null and t0 >= $2",
    [sessionId, t - 1],
  );
  await db.query(
    "update session_gaps set t1 = $2 where session_id = $1 and filled_at is null and stage is null and t0 < $2 and t1 > $2",
    [sessionId, t],
  );
}
