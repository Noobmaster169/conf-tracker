import { type SummaryBody, TalkSummary } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  talk_id: string;
  session_id: string;
  summary: unknown;
  created_at: Date;
}

const COLUMNS = "id, talk_id, session_id, summary, created_at";
const toSummary = (row: Row): TalkSummary =>
  TalkSummary.parse({ ...row, id: Number(row.id), talk_id: Number(row.talk_id), created_at: row.created_at.toISOString() });

export async function insert(db: Queryable, input: { talkId: number; sessionId: string; callId: number; summary: SummaryBody }): Promise<TalkSummary> {
  const { rows } = await db.query<Row>(
    `insert into talk_summaries (talk_id, session_id, call_id, summary) values ($1, $2, $3, $4) returning ${COLUMNS}`,
    [input.talkId, input.sessionId, input.callId, JSON.stringify(input.summary)],
  );
  return toSummary(rows[0]!);
}

/** The summary shown for a talk: the newest one written. */
export async function latest(db: Queryable, talkId: number): Promise<TalkSummary | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from talk_summaries where talk_id = $1 order by id desc limit 1`, [talkId]);
  return rows[0] ? toSummary(rows[0]) : null;
}
