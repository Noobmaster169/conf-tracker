import { Talk, type TalkBody, type TalkSpeakerBody } from "../contracts";
import type { Queryable } from "../db";
import * as people from "./people";

export interface TalkRow {
  id: string;
  stage_id: string;
  title: string;
  description: string;
  kind: string;
  starts_at: string | null;
  ends_at: string | null;
  position: number;
  speakers: { id: number; name: string; org: string | null; title: string | null; photo_url: string | null; role: string }[];
}

// Speakers come along as one JSON column, in the order they were entered (moderators and hosts after the speakers).
export const FIELDS = `t.id, t.stage_id, t.title, t.description, t.kind, t.starts_at, t.ends_at, t.position,
    coalesce((
      select json_agg(json_build_object('id', p.id, 'name', p.name, 'org', p.org, 'title', p.title, 'photo_url', p.photo_url, 'role', ts.role)
                      order by (ts.role <> 'speaker'), p.id)
      from talk_speakers ts join people p on p.id = ts.person_id where ts.talk_id = t.id
    ), '[]'::json) as speakers`;
export const SELECT = `select ${FIELDS} from talks t`;

export const toTalk = (row: TalkRow): Talk => Talk.parse({ ...row, id: Number(row.id), speakers: row.speakers.map((s) => ({ ...s, id: Number(s.id) })) });

async function setSpeakers(db: Queryable, talkId: number, speakers: TalkSpeakerBody[]): Promise<void> {
  // The form sends the whole list, so the join rows are rewritten; the people themselves are never removed.
  await db.query("delete from talk_speakers where talk_id = $1", [talkId]);
  for (const s of speakers) {
    const person = await people.upsertByName(db, { name: s.name, org: s.org, title: s.title });
    await db.query(
      "insert into talk_speakers (talk_id, person_id, role) values ($1, $2, $3) on conflict (talk_id, person_id) do update set role = excluded.role",
      [talkId, person.id, s.role],
    );
  }
}

export async function get(db: Queryable, id: number): Promise<Talk | null> {
  const { rows } = await db.query<TalkRow>(`${SELECT} where t.id = $1`, [id]);
  return rows[0] ? toTalk(rows[0]) : null;
}

/** Appended to the end of the stage's schedule. */
export async function create(db: Queryable, stageId: string, input: TalkBody): Promise<Talk> {
  const { rows } = await db.query<{ id: string }>(
    `insert into talks (stage_id, title, description, kind, starts_at, ends_at, position)
     values ($1, $2, $3, $4, $5, $6, (select coalesce(max(position), 0) + 1 from talks where stage_id = $1)) returning id`,
    [stageId, input.title, input.description, input.kind, input.starts_at, input.ends_at],
  );
  const id = Number(rows[0]!.id);
  await setSpeakers(db, id, input.speakers);
  return (await get(db, id))!;
}

export async function update(db: Queryable, id: number, input: TalkBody): Promise<Talk | null> {
  const { rowCount } = await db.query(
    "update talks set title = $2, description = $3, kind = $4, starts_at = $5, ends_at = $6 where id = $1 and archived_at is null",
    [id, input.title, input.description, input.kind, input.starts_at, input.ends_at],
  );
  if (!rowCount) return null;
  await setSpeakers(db, id, input.speakers);
  return get(db, id);
}

/** Off the schedule, but kept: a span or a summary may already point at it. */
export async function archive(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query("update talks set archived_at = now() where id = $1 and archived_at is null", [id]);
  return Boolean(rowCount);
}

/** A stage's schedule in running order. */
export async function forStage(db: Queryable, stageId: string): Promise<Talk[]> {
  const { rows } = await db.query<TalkRow>(`${SELECT} where t.stage_id = $1 and t.archived_at is null order by t.position asc, t.id asc`, [stageId]);
  return rows.map(toTalk);
}

/** The schedule a video is tracked against: its stage's talks, or none when it has no stage. */
export async function forSession(db: Queryable, sessionId: string): Promise<Talk[]> {
  const { rows } = await db.query<TalkRow>(
    `${SELECT} join sessions s on s.stage_id = t.stage_id where s.id = $1 and t.archived_at is null order by t.position asc, t.id asc`,
    [sessionId],
  );
  return rows.map(toTalk);
}
