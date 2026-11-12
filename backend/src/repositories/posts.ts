import { TalkPost } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  talk_id: string;
  session_id: string;
  text: string;
  created_at: Date;
}

const COLUMNS = "id, talk_id, session_id, text, created_at";
const toPost = (row: Row): TalkPost => TalkPost.parse({ ...row, id: Number(row.id), talk_id: Number(row.talk_id), created_at: row.created_at.toISOString() });

export async function insert(db: Queryable, input: { talkId: number; sessionId: string; callId: number; text: string }): Promise<TalkPost> {
  const { rows } = await db.query<Row>(
    `insert into talk_posts (talk_id, session_id, call_id, text) values ($1, $2, $3, $4) returning ${COLUMNS}`,
    [input.talkId, input.sessionId, input.callId, input.text],
  );
  return toPost(rows[0]!);
}

/** The post shown for a talk: the newest one written. */
export async function latest(db: Queryable, talkId: number): Promise<TalkPost | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from talk_posts where talk_id = $1 order by id desc limit 1`, [talkId]);
  return rows[0] ? toPost(rows[0]) : null;
}

/**
 * Talks of recent videos that have a summary from that video and no post written since it: the ones the Poster still
 * owes, such as every talk summarised before it existed, or one whose post failed while its summary did not.
 */
export async function unposted(db: Queryable, days = 7): Promise<{ sessionId: string; talkId: number }[]> {
  const { rows } = await db.query<{ session_id: string; talk_id: string }>(
    `select m.session_id, m.talk_id
       from talk_summaries m
       join sessions s on s.id = m.session_id
      where s.created_at > now() - make_interval(days => $1::int)
      group by m.session_id, m.talk_id
     having not exists (select 1 from talk_posts p where p.talk_id = m.talk_id and p.session_id = m.session_id and p.created_at >= max(m.created_at))
      order by m.session_id, m.talk_id`,
    [days],
  );
  return rows.map((r) => ({ sessionId: r.session_id, talkId: Number(r.talk_id) }));
}
