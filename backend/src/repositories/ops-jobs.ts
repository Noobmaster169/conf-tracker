import type { Queryable } from "../db";

export interface OpsJob {
  id: number;
  verb: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  output: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface Row extends Omit<OpsJob, "id" | "created_at" | "started_at" | "finished_at"> {
  id: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLUMNS = "id, verb, args, status, output, created_at, started_at, finished_at";
// A job can carry a secret for the box (set-env). Only the box's claim reads it; every other answer hides it.
const SECRET_ARGS = ["value"];

function toJob(row: Row, opts: { secrets?: boolean } = {}): OpsJob {
  const args = { ...row.args };
  if (!opts.secrets) for (const key of SECRET_ARGS) if (key in args) args[key] = "<hidden>";
  return {
    ...row,
    id: Number(row.id),
    args,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    finished_at: row.finished_at?.toISOString() ?? null,
  };
}

export async function create(db: Queryable, verb: string, args: Record<string, unknown>): Promise<OpsJob> {
  const { rows } = await db.query<Row>(`insert into ops_jobs (verb, args) values ($1, $2) returning ${COLUMNS}`, [verb, JSON.stringify(args)]);
  return toJob(rows[0]!);
}

export async function get(db: Queryable, id: number): Promise<OpsJob | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from ops_jobs where id = $1`, [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

export async function list(db: Queryable, limit: number): Promise<OpsJob[]> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from ops_jobs order by id desc limit $1`, [limit]);
  return rows.map((row) => toJob(row));
}

/** The oldest queued job becomes the box's, with its secrets. Two claims at once never take the same one. */
export async function claim(db: Queryable): Promise<OpsJob | null> {
  const { rows } = await db.query<Row>(
    `update ops_jobs set status = 'running', started_at = now()
     where id = (select id from ops_jobs where status = 'queued' order by id limit 1 for update skip locked)
     returning ${COLUMNS}`,
  );
  return rows[0] ? toJob(rows[0], { secrets: true }) : null;
}

/** What the box says happened. The secrets a job carried are wiped here: they are needed only until it has run. */
export async function finish(db: Queryable, id: number, ok: boolean, output: string): Promise<OpsJob | null> {
  const { rows } = await db.query<Row>(
    `update ops_jobs set status = $2, output = $3, finished_at = now(), args = args - $4::text[]
     where id = $1 and status = 'running' returning ${COLUMNS}`,
    [id, ok ? "done" : "failed", output, SECRET_ARGS],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** Model calls of the last while, per step: how many answered, how many failed, and the newest failure's reason. */
export async function callHealth(db: Queryable, minutes: number): Promise<{ step: string; ok: number; failed: number; last_error: string | null; last_at: string | null }[]> {
  const { rows } = await db.query<{ step: string; ok: number; failed: number; last_error: string | null; last_at: Date | null }>(
    `select step,
            count(*) filter (where error is null)::int as ok,
            count(*) filter (where error is not null)::int as failed,
            (array_agg(left(error, 300) order by id desc) filter (where error is not null))[1] as last_error,
            max(created_at) as last_at
     from llm_calls where created_at > now() - make_interval(mins => $1) group by step order by step`,
    [minutes],
  );
  return rows.map((row) => ({ ...row, last_at: row.last_at?.toISOString() ?? null }));
}
