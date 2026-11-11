import type { Queryable } from "../db";

const floorHalf = (t: number): number => Math.floor(t * 2) / 2;

/**
 * Where the next leg starts: the end of the last stored segment, lowered to the end of the last
 * diarization window when the video has any and that is smaller, rounded down to a frame (0.5 s) and then lowered until no segment straddles it. 0 when empty.
 */
export async function resumePoint(db: Queryable, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ seg: number | null; win: number | null }>(
    `select (select max(t1) from segments where session_id = $1) as seg,
            (select max(t1) from diar_windows where session_id = $1) as win`,
    [sessionId],
  );
  const { seg, win } = rows[0]!;
  if (seg === null) return 0;
  let r = floorHalf(win !== null && win < seg ? win : seg);
  // Never inside a stored segment: the next leg re-reads from r, so a segment cut at r would lose its start.
  // Lowering can land inside another (overlapping) segment, so repeat until none straddles.
  for (;;) {
    const { rows: straddle } = await db.query<{ t0: number | null }>(
      "select min(t0) as t0 from segments where session_id = $1 and t0 < $2 and t1 > $2",
      [sessionId, r],
    );
    const t0 = straddle[0]!.t0;
    if (t0 === null) return r;
    r = floorHalf(t0);
  }
}

/**
 * Deletes what a leg starting at t will re-read: segments ending after t, then the turns of the windows
 * ending after t, then those windows. Claims, spans, speakers and summaries stay. Opens no transaction.
 */
export async function truncateAfter(db: Queryable, sessionId: string, t: number): Promise<void> {
  await db.query("delete from segments where session_id = $1 and t1 > $2", [sessionId, t]);
  await db.query(
    "delete from turns where session_id = $1 and window_id in (select id from diar_windows where session_id = $1 and t1 > $2)",
    [sessionId, t],
  );
  await db.query("delete from diar_windows where session_id = $1 and t1 > $2", [sessionId, t]);
}

/** The highest N among the video's `SN` speaker ids (merged rows included), 0 if none. */
export async function speakerFloor(db: Queryable, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ n: number | null }>(
    "select max(substring(speaker_id from 2)::bigint)::float8 as n from speakers where session_id = $1 and speaker_id ~ '^S[0-9]+$'",
    [sessionId],
  );
  return rows[0]!.n ?? 0;
}
