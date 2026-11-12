import { Person } from "../contracts";
import type { Queryable } from "../db";
import { TerminalError } from "../lib/errors";

export interface PersonRow {
  id: string;
  name: string;
  org: string | null;
  title: string | null;
  photo_url: string | null;
}

export const COLUMNS = "id, name, org, title, photo_url";
// bigserial comes back as a string from pg.
export const toPerson = (row: PersonRow): Person => Person.parse({ ...row, id: Number(row.id) });

export interface NewPerson {
  name: string;
  org?: string | null;
  title?: string | null;
  photo_url?: string | null;
}

/** The person of this name, made if new. A known person keeps what is already written and only gains what was missing. */
export async function upsertByName(db: Queryable, input: NewPerson): Promise<Person> {
  const { rows } = await db.query<PersonRow>(
    `insert into people (name, org, title, photo_url) values ($1, $2, $3, $4)
     on conflict (lower(name)) do update set
       org = coalesce(people.org, excluded.org), title = coalesce(people.title, excluded.title),
       photo_url = coalesce(people.photo_url, excluded.photo_url), updated_at = now()
     returning ${COLUMNS}`,
    [input.name, input.org ?? null, input.title ?? null, input.photo_url ?? null],
  );
  return toPerson(rows[0]!);
}

export async function get(db: Queryable, id: number): Promise<Person | null> {
  const { rows } = await db.query<PersonRow>(`select ${COLUMNS} from people where id = $1`, [id]);
  return rows[0] ? toPerson(rows[0]) : null;
}

/** The admin's edit: every field is written as given. Null when there is no such person. */
export async function update(db: Queryable, id: number, input: Required<NewPerson>): Promise<Person | null> {
  try {
    const { rows } = await db.query<PersonRow>(
      `update people set name = $2, org = $3, title = $4, photo_url = $5, updated_at = now() where id = $1 returning ${COLUMNS}`,
      [id, input.name, input.org, input.title, input.photo_url],
    );
    return rows[0] ? toPerson(rows[0]) : null;
  } catch (error) {
    // 23505 is the unique index on lower(name): two people cannot share a name.
    if ((error as { code?: string }).code === "23505") throw new TerminalError(`someone is already called ${input.name}`, { cause: error });
    throw error;
  }
}

/**
 * Takes a person out for good. Refused while they are on a schedule or a voice in a video is theirs: those would lose
 * their name. Null when there is no such person.
 */
export async function remove(db: Queryable, id: number): Promise<boolean | null> {
  if (!(await get(db, id))) return null;
  const { rows } = await db.query(
    `select 1 from talk_speakers ts join talks t on t.id = ts.talk_id where ts.person_id = $1 and t.archived_at is null
     union all select 1 from speakers where person_id = $1 limit 1`,
    [id],
  );
  if (rows.length > 0) throw new TerminalError("this speaker is on a schedule or was heard in a video; take them off the session first");
  // What is left can only be a place on a session that was itself removed from its schedule, and a stored photo.
  await db.query("delete from talk_speakers where person_id = $1", [id]);
  await db.query("delete from person_photos where person_id = $1", [id]);
  await db.query("delete from person_conferences where person_id = $1", [id]);
  await db.query("delete from people where id = $1", [id]);
  return true;
}

/** Everyone a video's page may need to show: the people its named speakers are, and the people on its stage's schedule. */
export async function forSession(db: Queryable, sessionId: string): Promise<Person[]> {
  const { rows } = await db.query<PersonRow>(
    `select ${COLUMNS} from people where id in (
       select person_id from speakers where session_id = $1 and person_id is not null
       union
       select ts.person_id from talk_speakers ts join talks t on t.id = ts.talk_id join sessions s on s.stage_id = t.stage_id
       where s.id = $1 and t.archived_at is null
     ) order by name asc`,
    [sessionId],
  );
  return rows.map(toPerson);
}

/** Lists a person for a conference they have no tracked session at yet. False when there is no such person. */
export async function addConference(db: Queryable, id: number, conference: string): Promise<boolean> {
  if (!(await get(db, id))) return false;
  await db.query("insert into person_conferences (person_id, conference) values ($1, $2) on conflict do nothing", [id, conference]);
  return true;
}

/** Takes that listing away again; the schedule and the videos still place the person wherever they are. */
export async function removeConference(db: Queryable, id: number, conference: string): Promise<boolean> {
  const { rowCount } = await db.query("delete from person_conferences where person_id = $1 and conference = $2", [id, conference]);
  return (rowCount ?? 0) > 0;
}
