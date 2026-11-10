import { Speaker } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  speaker_id: string;
  first_seen_t: number;
  last_seen_t: number;
  talk_s: number;
  merged_into: string | null;
  name: string | null;
  role: string | null;
  name_confidence: number | null;
  name_quote: string | null;
  name_call_id: string | null;
  person_id: string | null;
}

const COLUMNS = "speaker_id, first_seen_t, last_seen_t, talk_s, merged_into, name, role, name_confidence, name_quote, name_call_id, person_id";
// The same columns read off the `s` alias of a self join.
const S_COLUMNS = COLUMNS.split(", ").map((c) => `s.${c}`).join(", ");
// bigint comes back as a string from pg.
const toSpeaker = (row: Row): Speaker =>
  Speaker.parse({ ...row, name_call_id: row.name_call_id === null ? null : Number(row.name_call_id), person_id: row.person_id === null ? null : Number(row.person_id) });

export async function upsert(
  db: Queryable,
  sessionId: string,
  input: { speakerId: string; firstSeenT: number; lastSeenT: number; talkS?: number },
): Promise<Speaker> {
  const { rows } = await db.query<Row>(
    `insert into speakers (session_id, speaker_id, first_seen_t, last_seen_t, talk_s)
     values ($1, $2, $3, $4, coalesce($5::float8, 0))
     on conflict (session_id, speaker_id) do update set
       first_seen_t = least(speakers.first_seen_t, excluded.first_seen_t),
       last_seen_t = greatest(speakers.last_seen_t, excluded.last_seen_t),
       talk_s = coalesce($5::float8, speakers.talk_s)
     returning ${COLUMNS}`,
    [sessionId, input.speakerId, input.firstSeenT, input.lastSeenT, input.talkS ?? null],
  );
  return toSpeaker(rows[0]!);
}

export async function markMerged(db: Queryable, sessionId: string, speakerId: string, into: string): Promise<Speaker | null> {
  const { rows } = await db.query<Row>(
    `update speakers set merged_into = $3 where session_id = $1 and speaker_id = $2 returning ${COLUMNS}`,
    [sessionId, speakerId, into],
  );
  return rows[0] ? toSpeaker(rows[0]) : null;
}

export interface NewName {
  name: string;
  role: string | null;
  confidence: number;
  quote: string;
  callId: number;
}

/**
 * Writes an accepted proposal onto the speaker. The judge saw a roster read before the model call, and a merge can land
 * in between, so the write rechecks: it refuses a label merged away or a name held at equal or higher confidence.
 * Null when nothing was written.
 */
export async function setName(db: Queryable, sessionId: string, speakerId: string, input: NewName): Promise<Speaker | null> {
  const { rows } = await db.query<Row>(
    `update speakers set name = $3, role = $4, name_confidence = $5, name_quote = $6, name_call_id = $7
     where session_id = $1 and speaker_id = $2 and merged_into is null and (name is null or name_confidence < $5)
     returning ${COLUMNS}`,
    [sessionId, speakerId, input.name, input.role, input.confidence, input.quote, input.callId],
  );
  return rows[0] ? toSpeaker(rows[0]) : null;
}

/** On a merge the survivor takes the absorbed speaker's name when it is the more confident one. Null when nothing changed. */
export async function inheritName(db: Queryable, sessionId: string, from: string, into: string): Promise<Speaker | null> {
  const { rows } = await db.query<Row>(
    `update speakers s set name = f.name, role = f.role, name_confidence = f.name_confidence, name_quote = f.name_quote, name_call_id = f.name_call_id,
       person_id = f.person_id
     from speakers f
     where s.session_id = $1 and s.speaker_id = $3 and f.session_id = $1 and f.speaker_id = $2
       and f.name is not null and (s.name is null or f.name_confidence > s.name_confidence)
     returning ${S_COLUMNS}`,
    [sessionId, from, into],
  );
  return rows[0] ? toSpeaker(rows[0]) : null;
}

export async function list(db: Queryable, sessionId: string): Promise<Speaker[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from speakers where session_id = $1 order by first_seen_t asc, speaker_id asc`, [sessionId]);
  return rows.map(toSpeaker);
}

export async function get(db: Queryable, sessionId: string, speakerId: string): Promise<Speaker | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from speakers where session_id = $1 and speaker_id = $2`, [sessionId, speakerId]);
  return rows[0] ? toSpeaker(rows[0]) : null;
}

/** Points a named label at the person it is, and takes the person's spelling of the name. Null when the label is gone. */
export async function setPerson(db: Queryable, sessionId: string, speakerId: string, person: { id: number; name: string }): Promise<Speaker | null> {
  const { rows } = await db.query<Row>(
    `update speakers set person_id = $3, name = $4 where session_id = $1 and speaker_id = $2 returning ${COLUMNS}`,
    [sessionId, speakerId, person.id, person.name],
  );
  return rows[0] ? toSpeaker(rows[0]) : null;
}

// A name given by hand outranks anything the model can propose: setName only replaces a weaker one.
const BY_HAND = 1;

/** Says by hand whose voice a label is. The person's spelling becomes the name, and no later proposal can replace it. Null when the label is gone. */
export async function assign(db: Queryable, sessionId: string, speakerId: string, person: { id: number; name: string }, role: string | null): Promise<Speaker | null> {
  const { rows } = await db.query<Row>(
    `update speakers set person_id = $3, name = $4, role = coalesce($5, role), name_confidence = $6, name_quote = null, name_call_id = null
     where session_id = $1 and speaker_id = $2 returning ${COLUMNS}`,
    [sessionId, speakerId, person.id, person.name, role, BY_HAND],
  );
  return rows[0] ? toSpeaker(rows[0]) : null;
}

/** Takes a wrong name off a label. On a video still running the namer may name it again. Null when the label is gone. */
export async function clearName(db: Queryable, sessionId: string, speakerId: string): Promise<Speaker | null> {
  const { rows } = await db.query<Row>(
    `update speakers set person_id = null, name = null, role = null, name_confidence = null, name_quote = null, name_call_id = null
     where session_id = $1 and speaker_id = $2 returning ${COLUMNS}`,
    [sessionId, speakerId],
  );
  return rows[0] ? toSpeaker(rows[0]) : null;
}
