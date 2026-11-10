import { z } from "zod";

import { Stage, type StageBody } from "../contracts";
import type { Queryable } from "../db";

export interface StageRow {
  id: string;
  conference: string;
  name: string;
  day: string | null;
  description: string;
  created_at: Date;
}

// The date is read as text: pg would otherwise hand back a Date at local midnight, a day off in some zones.
export const COLUMNS = "id, conference, name, day::text as day, description, created_at";
export const toStage = (row: StageRow): Stage => Stage.parse({ ...row, created_at: row.created_at.toISOString() });

export async function create(db: Queryable, input: StageBody): Promise<Stage> {
  const { rows } = await db.query<StageRow>(
    `insert into stages (conference, name, day, description) values ($1, $2, $3, $4) returning ${COLUMNS}`,
    [input.conference, input.name, input.day, input.description],
  );
  return toStage(rows[0]!);
}

export async function update(db: Queryable, id: string, input: StageBody): Promise<Stage | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const { rows } = await db.query<StageRow>(
    `update stages set conference = $2, name = $3, day = $4, description = $5 where id = $1 returning ${COLUMNS}`,
    [id, input.conference, input.name, input.day, input.description],
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
