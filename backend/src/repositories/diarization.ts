import { WindowRecord, type Match, type Turn } from "../contracts";
import type { Queryable } from "../db";

interface Row {
  id: string;
  t0: number;
  t1: number;
  gpu_ms: number;
  matches: Match[];
}

const COLUMNS = "id, t0, t1, gpu_ms, matches";
// bigserial comes back as a string from pg.
const toWindow = (row: Row): WindowRecord => WindowRecord.parse({ ...row, id: Number(row.id) });

export async function insertWindow(
  db: Queryable,
  sessionId: string,
  input: { t0: number; t1: number; gpuMs: number; matches: Match[]; turns: Turn[] },
): Promise<WindowRecord> {
  const { rows } = await db.query<Row>(
    `insert into diar_windows (session_id, t0, t1, gpu_ms, matches) values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [sessionId, input.t0, input.t1, input.gpuMs, JSON.stringify(input.matches)],
  );
  const window = toWindow(rows[0]!);
  if (input.turns.length > 0) {
    await db.query(
      `insert into turns (session_id, window_id, t0, t1, speaker_id)
       select $1, $2, * from unnest($3::float8[], $4::float8[], $5::text[])`,
      [sessionId, window.id, input.turns.map((t) => t.t0), input.turns.map((t) => t.t1), input.turns.map((t) => t.speaker_id)],
    );
  }
  return window;
}

export async function windowsFor(db: Queryable, sessionId: string, speakerId: string, limit = 30): Promise<WindowRecord[]> {
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from diar_windows
     where session_id = $1 and matches @> $2::jsonb
     order by t1 desc, id desc limit $3`,
    [sessionId, JSON.stringify([{ speaker_id: speakerId }]), limit],
  );
  return rows.map(toWindow);
}
