import { z } from "zod";

import { Session, type SessionStatus } from "../contracts";
import type { Queryable } from "../db";
import { TerminalError } from "../lib/errors";
import { videoIdFromUrl } from "../lib/youtube-id";

interface Row {
  id: string;
  source_url: string | null;
  source_file: string | null;
  replay_of: string | null;
  status: string;
  started_at: Date | null;
  stopped_at: Date | null;
  config: Record<string, unknown>;
  models: Record<string, string>;
  error: string | null;
  created_at: Date;
}

const COLUMNS = "id, source_url, source_file, replay_of, status, started_at, stopped_at, config, models, error, created_at";

function toFoundSession(id: string, row: Row | undefined): Session {
  if (!row) throw new TerminalError(`session ${id} not found`);
  return toSession(row);
}

function toSession(row: Row): Session {
  return Session.parse({
    ...row,
    video_id: row.source_url ? videoIdFromUrl(row.source_url) : null,
    started_at: row.started_at?.toISOString() ?? null,
    stopped_at: row.stopped_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  });
}

export interface NewSession {
  sourceUrl: string | null;
  sourceFile: string | null;
  config: Record<string, unknown>;
  replayOf?: string | null;
}

export async function create(db: Queryable, input: NewSession): Promise<Session> {
  const { rows } = await db.query<Row>(
    `insert into sessions (source_url, source_file, config, replay_of) values ($1, $2, $3, $4) returning ${COLUMNS}`,
    [input.sourceUrl, input.sourceFile, JSON.stringify(input.config), input.replayOf ?? null],
  );
  return toSession(rows[0]!);
}

export async function get(db: Queryable, id: string): Promise<Session | null> {
  // Postgres raises on a malformed uuid literal; a bad id is a 404, not a 500.
  if (!z.uuid().safeParse(id).success) return null;
  const { rows } = await db.query<Row>(`select ${COLUMNS} from sessions where id = $1`, [id]);
  return rows[0] ? toSession(rows[0]) : null;
}

export async function list(db: Queryable): Promise<Session[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from sessions order by created_at desc limit 100`);
  return rows.map(toSession);
}

export async function markStarted(db: Queryable, id: string, input: { startedAt: string; models: Record<string, string> }): Promise<Session> {
  const { rows } = await db.query<Row>(
    `update sessions set status = 'live', started_at = $2, models = $3 where id = $1 returning ${COLUMNS}`,
    [id, input.startedAt, JSON.stringify(input.models)],
  );
  return toFoundSession(id, rows[0]);
}

export async function setStatus(db: Queryable, id: string, status: SessionStatus): Promise<Session> {
  const { rows } = await db.query<Row>(
    // stopped_at is audited: a repeated stop must not move the original stop time.
    `update sessions set status = $2, stopped_at = case when $2 = 'stopped' then coalesce(stopped_at, now()) else stopped_at end
     where id = $1 returning ${COLUMNS}`,
    [id, status],
  );
  return toFoundSession(id, rows[0]);
}

/** Rows a previous process left mid-flight. Nothing serves them any more, so they are degraded, not live. */
export async function markOrphansDegraded(db: Queryable): Promise<Session[]> {
  const { rows } = await db.query<Row>(
    `update sessions set status = 'degraded' where status in ('starting', 'live') returning ${COLUMNS}`,
  );
  return rows.map(toSession);
}

/** Stops the session and keeps why, so an error end is never a black box. */
export async function setError(db: Queryable, id: string, error: string): Promise<Session> {
  const { rows } = await db.query<Row>(
    `update sessions set status = 'stopped', stopped_at = coalesce(stopped_at, now()), error = $2 where id = $1 returning ${COLUMNS}`,
    [id, error],
  );
  return toFoundSession(id, rows[0]);
}
