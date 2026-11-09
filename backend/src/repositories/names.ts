import { NameProposal, type ProposalStatus } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  session_id: string;
  call_id: string;
  speaker_id: string;
  name: string;
  role: string | null;
  confidence: number;
  quote: string;
  quote_verified: boolean;
  status: string;
  reason: string | null;
  created_at: Date;
}

const COLUMNS = "id, session_id, call_id, speaker_id, name, role, confidence, quote, quote_verified, status, reason, created_at";
// bigserial and bigint come back as strings from pg.
const toProposal = (row: Row): NameProposal =>
  NameProposal.parse({ ...row, id: Number(row.id), call_id: Number(row.call_id), created_at: row.created_at.toISOString() });

export interface NewProposal {
  speakerId: string;
  name: string;
  role: string | null;
  confidence: number;
  quote: string;
  quoteVerified: boolean;
  status: ProposalStatus;
  reason: string | null;
}

/** Stores the proposals of one call in the order the model gave them; ids follow that order. */
export async function insertMany(db: Queryable, sessionId: string, callId: number, items: NewProposal[]): Promise<NameProposal[]> {
  const stored: NameProposal[] = [];
  for (const item of items) {
    const { rows } = await db.query<Row>(
      `insert into name_proposals (session_id, call_id, speaker_id, name, role, confidence, quote, quote_verified, status, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`,
      [sessionId, callId, item.speakerId, item.name, item.role, item.confidence, item.quote, item.quoteVerified, item.status, item.reason],
    );
    stored.push(toProposal(rows[0]!));
  }
  return stored;
}

/**
 * A speaker's proposals, newest first: the drawer reads the latest verdict at the top. A survivor also shows the
 * proposals made for labels merged straight into it, since that evidence is about the same person. Only one hop: a
 * chain of merges is rare and the drawer is a view of evidence, not the naming decision.
 */
export async function forSpeaker(db: Queryable, sessionId: string, speakerId: string, limit = 20): Promise<NameProposal[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from name_proposals
     where session_id = $1 and (speaker_id = $2
       or speaker_id in (select speaker_id from speakers where session_id = $1 and merged_into = $2))
     order by id desc limit $3`,
    [sessionId, speakerId, limit],
  );
  return rows.map(toProposal);
}

export async function forCall(db: Queryable, callId: number): Promise<NameProposal[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from name_proposals where call_id = $1 order by id asc`, [callId]);
  return rows.map(toProposal);
}
