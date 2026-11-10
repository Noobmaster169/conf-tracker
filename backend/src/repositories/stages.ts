import { z } from "zod";

import { Stage, type StageBody } from "../contracts";
import type { Queryable } from "../db";
import { TerminalError } from "../lib/errors";

export interface StageRow {
  id: string;
  conference: string;
  name: string;
  day: string | null;
  description: string;
  hidden: boolean;
  created_at: Date;
}

// The date is read as text: pg would otherwise hand back a Date at local midnight, a day off in some zones.
export const COLUMNS = "id, conference, name, day::text as day, description, hidden, created_at";
export const toStage = (row: StageRow): Stage => Stage.parse({ ...row, created_at: row.created_at.toISOString() });

type StageInput = Omit<StageBody, "hidden"> & { hidden?: boolean };

export async function create(db: Queryable, input: StageInput): Promise<Stage> {
  const { rows } = await db.query<StageRow>(
    `insert into stages (conference, name, day, description, hidden) values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [input.conference, input.name, input.day, input.description, input.hidden ?? false],
  );
  return toStage(rows[0]!);
}

export async function update(db: Queryable, id: string, input: StageInput): Promise<Stage | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const { rows } = await db.query<StageRow>(
    `update stages set conference = $2, name = $3, day = $4, description = $5, hidden = $6 where id = $1 returning ${COLUMNS}`,
    [id, input.conference, input.name, input.day, input.description, input.hidden ?? false],
  );
  return rows[0] ? toStage(rows[0]) : null;
}

export async function get(db: Queryable, id: string): Promise<Stage | null> {
  // Postgres raises on a malformed uuid literal; a bad id is a 404, not a 500.
  if (!z.uuid().safeParse(id).success) return null;
  const { rows } = await db.query<StageRow>(`select ${COLUMNS} from stages where id = $1`, [id]);
  return rows[0] ? toStage(rows[0]) : null;
}

export async function list(db: Queryable): Promise<Stage[]> {
  const { rows } = await db.query<StageRow>(`select ${COLUMNS} from stages order by day desc nulls last, created_at desc`);
  return rows.map(toStage);
}

/**
 * Takes a stage and its schedule out for good. Refused while a video is on it, or while a video elsewhere still holds a
 * stretch of timeline or a summary for one of its sessions: those would lose what they point at. The people stay.
 * Null when there is no such stage. Run inside one transaction.
 */
export async function remove(db: Queryable, id: string): Promise<boolean | null> {
  if (!(await get(db, id))) return null;
  const { rows } = await db.query(
    `select 1 from sessions where stage_id = $1
     union all select 1 from talk_spans k join talks t on t.id = k.talk_id where t.stage_id = $1
     union all select 1 from talk_summaries m join talks t on t.id = m.talk_id where t.stage_id = $1 limit 1`,
    [id],
  );
  if (rows.length > 0) throw new TerminalError("this stage has videos or sessions heard in a video; move or delete those videos first, or hide the stage");
  await db.query("delete from talk_speakers where talk_id in (select id from talks where stage_id = $1)", [id]);
  await db.query("delete from talks where stage_id = $1", [id]);
  await db.query("delete from stages where id = $1", [id]);
  return true;
}
