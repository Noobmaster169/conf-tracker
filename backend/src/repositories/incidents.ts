import type { Incident } from "../contracts-agents";
import type { Queryable } from "../db";
import type { Finding } from "../ingest/watch-rules";

interface Row {
  id: string;
  rule: string;
  agent_id: string | null;
  session_id: string | null;
  session_title: string | null;
  call_id: string | null;
  parent_id: string | null;
  title: string;
  detail: string;
  diagnosis: string | null;
  first_seen: Date;
  last_seen: Date;
  count: number;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
}

const COLUMNS = `i.id, i.rule, i.agent_id, i.session_id, (select title from sessions s where s.id = i.session_id) as session_title, i.call_id, i.parent_id,
  i.title, i.detail, i.diagnosis, i.first_seen, i.last_seen, i.count, i.acknowledged_at, i.resolved_at`;

const toIncident = (row: Row): Incident => ({
  ...row,
  id: Number(row.id),
  call_id: row.call_id === null ? null : Number(row.call_id),
  parent_id: row.parent_id === null ? null : Number(row.parent_id),
  first_seen: row.first_seen.toISOString(),
  last_seen: row.last_seen.toISOString(),
  acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
  resolved_at: row.resolved_at?.toISOString() ?? null,
});

/** Shown as open: the trouble is still there and nobody has marked it resolved. */
export const SHOWN_OPEN = "resolved_at is null and acknowledged_at is null";

/** Records a finding: a new incident, or one more sighting of the one already open for that rule, agent and video. */
export async function upsertOpen(db: Queryable, finding: Finding, parentId: number | null): Promise<{ incident: Incident; opened: boolean }> {
  const { rows } = await db.query<Row & { opened: boolean }>(
    `with i as (
       insert into incidents (rule, agent_id, session_id, call_id, parent_id, title, detail)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (rule, coalesce(agent_id, ''), coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)) where resolved_at is null
       do update set last_seen = now(), count = incidents.count + 1, clear_passes = 0, title = excluded.title, detail = excluded.detail,
                     call_id = coalesce(excluded.call_id, incidents.call_id), parent_id = excluded.parent_id
       returning *, (xmax = 0) as opened
     ) select ${COLUMNS}, i.opened from i`,
    [finding.rule, finding.agentId, finding.sessionId, finding.callId, parentId, finding.title, finding.detail],
  );
  const { opened, ...row } = rows[0]!;
  return { incident: toIncident(row), opened };
}

/**
 * Every open incident not seen this pass has been clear for one more pass; one clear for `clearPasses` in a row is
 * resolved. Returns the ids resolved.
 */
export async function sweepCleared(db: Queryable, seenIds: number[], clearPasses: number): Promise<number[]> {
  await db.query(`update incidents set clear_passes = clear_passes + 1 where resolved_at is null and id <> all($1::bigint[])`, [seenIds]);
  const { rows } = await db.query<{ id: string }>(`update incidents set resolved_at = now() where resolved_at is null and clear_passes >= $1 returning id`, [clearPasses]);
  return rows.map((row) => Number(row.id));
}

/** Open ones first, then the newest. */
export async function list(db: Queryable, opts: { open?: boolean; agentId?: string; limit: number }): Promise<Incident[]> {
  const where = ["true"];
  const values: unknown[] = [];
  if (opts.open) where.push(`i.${SHOWN_OPEN.replaceAll(" and ", " and i.")}`);
  if (opts.agentId) {
    values.push(opts.agentId);
    where.push(`i.agent_id = $${values.length}`);
  }
  values.push(opts.limit);
  const { rows } = await db.query<Row>(
    `select ${COLUMNS} from incidents i where ${where.join(" and ")}
      order by (i.resolved_at is null and i.acknowledged_at is null) desc, i.last_seen desc, i.id desc limit $${values.length}`,
    values,
  );
  return rows.map(toIncident);
}

export async function get(db: Queryable, id: number): Promise<Incident | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from incidents i where i.id = $1`, [id]);
  return rows[0] ? toIncident(rows[0]) : null;
}

/** Marked resolved by hand. One already marked, or already gone, is answered as it is. */
export async function resolve(db: Queryable, id: number): Promise<Incident | null> {
  await db.query(`update incidents set acknowledged_at = now() where id = $1 and acknowledged_at is null and resolved_at is null`, [id]);
  return get(db, id);
}

export async function setDiagnosis(db: Queryable, id: number, text: string): Promise<void> {
  await db.query(`update incidents set diagnosis = $2 where id = $1`, [id, text]);
}
