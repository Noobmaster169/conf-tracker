import type { Person } from "../contracts";
import type { Queryable } from "../db";
import { COLUMNS, toPerson, type PersonRow } from "./people";

export interface Photo {
  content_type: string;
  bytes: Buffer;
}

/** Where a stored photo is read from. The version changes with every upload, so a reader may cache one forever. */
export const photoPath = (personId: number, version: number): string => `/people/${personId}/photo?v=${version}`;

/** Keeps the image and points the person at it. Null when there is no such person. */
export async function put(db: Queryable, personId: number, photo: Photo): Promise<Person | null> {
  const { rows } = await db.query<PersonRow>(
    `with stored as (
       insert into person_photos (person_id, content_type, bytes)
       select id, $2, $3 from people where id = $1
       on conflict (person_id) do update set content_type = excluded.content_type, bytes = excluded.bytes, updated_at = now()
       returning person_id
     )
     update people set photo_url = $4, updated_at = now() from stored where people.id = stored.person_id returning ${COLUMNS.split(", ").map((c) => `people.${c}`).join(", ")}`,
    [personId, photo.content_type, photo.bytes, photoPath(personId, Date.now())],
  );
  return rows[0] ? toPerson(rows[0]) : null;
}

export async function get(db: Queryable, personId: number): Promise<Photo | null> {
  const { rows } = await db.query<Photo>("select content_type, bytes from person_photos where person_id = $1", [personId]);
  return rows[0] ?? null;
}
