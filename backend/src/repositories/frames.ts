import type { Frame } from "../contracts-frames";
import type { Queryable } from "../db";
import type { Signed } from "../frames/signature";

interface Row {
  id: string;
  session_id: string;
  t: number;
  talk_id: string | null;
  key: string;
  thumb_key: string;
  width: number;
  height: number;
  hidden: boolean;
  blocked: boolean;
  created_at: Date;
}

export type PublicUrl = (key: string) => string;

const toFrame = (row: Row, url: PublicUrl): Frame => ({
  id: Number(row.id),
  session_id: row.session_id,
  t: row.t,
  talk_id: row.talk_id === null ? null : Number(row.talk_id),
  url: url(row.key),
  thumb_url: url(row.thumb_key),
  width: row.width,
  height: row.height,
  hidden: row.hidden,
  blocked: row.blocked,
  created_at: row.created_at.toISOString(),
});

// The span in force at the frame's time, as a claim finds its talk: the latest one starting at or before it, and still
// running then. Read, not stored, so a corrected timeline re-sorts frames with no write to them.
const SPAN = `left join lateral (
    select p.talk_id, p.state from talk_spans p
     where p.session_id = f.session_id and p.t0 <= f.t and (p.t1 is null or p.t1 > f.t)
     order by p.t0 desc, p.id desc limit 1
  ) sp on true`;
const COLUMNS = "f.id, f.session_id, f.t, sp.talk_id, f.key, f.thumb_key, f.width, f.height, f.hidden, f.blocked, f.created_at";
// What a gallery shows: not hidden, and not in a break (a holding card, the stage between talks).
const SHOWN = "not f.hidden and coalesce(sp.state, 'talk') <> 'break'";

export interface NewFrame extends Signed {
  sessionId: string;
  t: number;
  key: string;
  thumbKey: string;
  width: number;
  height: number;
}

export async function add(db: Queryable, input: NewFrame, url: PublicUrl): Promise<Frame> {
  const { rows } = await db.query<{ id: string }>(
    `insert into frames (session_id, t, key, thumb_key, width, height, sig, motion) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [input.sessionId, input.t, input.key, input.thumbKey, input.width, input.height, Buffer.from(input.sig), Buffer.from(input.motion)],
  );
  return (await get(db, Number(rows[0]!.id), url))!;
}

export async function get(db: Queryable, id: number, url: PublicUrl): Promise<Frame | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from frames f ${SPAN} where f.id = $1`, [id]);
  return rows[0] ? toFrame(rows[0], url) : null;
}

/** A video's gallery, oldest first. `all` adds the hidden ones and the ones in a break. */
export async function forSession(db: Queryable, sessionId: string, url: PublicUrl, opts: { all?: boolean } = {}): Promise<Frame[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from frames f ${SPAN} where f.session_id = $1 ${opts.all ? "" : `and ${SHOWN}`} order by f.t, f.id`, [
    sessionId,
  ]);
  return rows.map((row) => toFrame(row, url));
}

/** A talk's gallery across every video it was on stage in, oldest first. */
export async function forTalk(db: Queryable, talkId: number, url: PublicUrl): Promise<Frame[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from frames f ${SPAN}
      where f.session_id in (select distinct p.session_id from talk_spans p join sessions s on s.id = p.session_id and s.replay_of is null where p.talk_id = $1) and sp.talk_id = $1 and ${SHOWN}
      order by f.created_at, f.t, f.id`,
    [talkId],
  );
  return rows.map((row) => toFrame(row, url));
}

/** Every frame of a video as signatures, the hidden ones too: a hidden frame still counts as seen. */
export async function signatures(db: Queryable, sessionId: string): Promise<(Signed & { t: number })[]> {
  const { rows } = await db.query<{ sig: Buffer; motion: Buffer; t: number }>("select sig, motion, t from frames where session_id = $1 order by t, id", [sessionId]);
  return rows.map((r) => ({ sig: new Uint8Array(r.sig), motion: new Uint8Array(r.motion), t: r.t }));
}

/** The screens kept out of every gallery. */
export async function blockedSignatures(db: Queryable): Promise<Signed[]> {
  const { rows } = await db.query<{ sig: Buffer; motion: Buffer }>("select sig, motion from frames where blocked");
  return rows.map((r) => ({ sig: new Uint8Array(r.sig), motion: new Uint8Array(r.motion) }));
}

/** Hides or shows a frame; `block` also keeps anything like it out (and implies hidden). */
export async function patch(db: Queryable, id: number, input: { hidden?: boolean; block?: boolean }, url: PublicUrl): Promise<Frame | null> {
  const blocked = input.block;
  const hidden = blocked === true ? true : input.hidden;
  await db.query(
    `update frames set hidden = coalesce($2, hidden), blocked = case when $2 = false then false else coalesce($3, blocked) end where id = $1`,
    [id, hidden ?? null, blocked ?? null],
  );
  return get(db, id, url);
}
