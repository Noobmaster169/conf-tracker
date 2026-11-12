import { agentForKey } from "../agents/registry";
import type { AgentEvent } from "../contracts-agents";
import type { Queryable } from "../db";

interface Row {
  id: string;
  agent_id: string;
  session_id: string | null;
  call_id: string | null;
  kind: "change" | "rerun";
  summary: string;
  data: unknown;
  actor: string;
  created_at: Date;
}

const COLUMNS = "id, agent_id, session_id, call_id, kind, summary, data, actor, created_at";
const toEvent = (row: Row): AgentEvent => ({ ...row, id: Number(row.id), call_id: row.call_id === null ? null : Number(row.call_id), created_at: row.created_at.toISOString() });

export interface NewEvent {
  agentId: string;
  sessionId?: string | null;
  callId?: number | null;
  kind: "change" | "rerun";
  summary: string;
  data?: unknown;
  actor: string;
}

export async function add(db: Queryable, event: NewEvent): Promise<AgentEvent> {
  const { rows } = await db.query<Row>(
    `insert into agent_events (agent_id, session_id, call_id, kind, summary, data, actor) values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
    [event.agentId, event.sessionId ?? null, event.callId ?? null, event.kind, event.summary, JSON.stringify(event.data ?? {}), event.actor],
  );
  return toEvent(rows[0]!);
}

export async function get(db: Queryable, id: number): Promise<AgentEvent | null> {
  const { rows } = await db.query<Row>(`select ${COLUMNS} from agent_events where id = $1`, [id]);
  return rows[0] ? toEvent(rows[0]) : null;
}

export async function setData(db: Queryable, id: number, data: unknown): Promise<void> {
  await db.query(`update agent_events set data = $2 where id = $1`, [id, JSON.stringify(data)]);
}

/** Newest first. `before` is a time: events made earlier than it. */
export async function list(db: Queryable, opts: { agentId?: string; callId?: number; before?: string; limit: number }): Promise<AgentEvent[]> {
  const where = ["true"];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  if (opts.agentId) add("agent_id = ?", opts.agentId);
  if (opts.callId) add("call_id = ?", opts.callId);
  if (opts.before) add("created_at < ?::timestamptz", opts.before);
  values.push(opts.limit);
  const { rows } = await db.query<Row>(`select ${COLUMNS} from agent_events where ${where.join(" and ")} order by created_at desc, id desc limit $${values.length}`, values);
  return rows.map(toEvent);
}

const show = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

export interface Change {
  agentId: string;
  /** "name_floor 0.7 → 0.6", several joined by a comma. Where it applies is added by the caller. */
  summary: string;
  data: { changes: { key: string; from: unknown; to: unknown }[] };
}

/**
 * What changed between two configs, one entry per agent whose settings differ. A key that is absent stands at its
 * default, so setting a key to its default, or taking one back to it, compares as what a video would actually read.
 */
export function changeSummaries(before: Record<string, unknown>, after: Record<string, unknown>): Change[] {
  const byAgent = new Map<string, Change["data"]["changes"]>();
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const agent = agentForKey(key);
    if (!agent?.settings) continue;
    const fallback = (agent.settings.parse({}) as Record<string, unknown>)[key];
    const from = key in before ? before[key] : fallback;
    const to = key in after ? after[key] : fallback;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    byAgent.set(agent.id, [...(byAgent.get(agent.id) ?? []), { key, from, to }]);
  }
  return [...byAgent.entries()].map(([agentId, changes]) => ({ agentId, summary: changes.map((c) => `${c.key} ${show(c.from)} → ${show(c.to)}`).join(", "), data: { changes } }));
}

/** Records what a config change did, one event per agent it touched. `where` ends the line: "for new videos", "on Main Stage". */
export async function recordChanges(
  db: Queryable,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  target: { where: string; sessionId?: string | null; actor: string },
): Promise<AgentEvent[]> {
  const written: AgentEvent[] = [];
  for (const change of changeSummaries(before, after)) {
    written.push(await add(db, { agentId: change.agentId, sessionId: target.sessionId ?? null, kind: "change", summary: `${change.summary} ${target.where}`, data: change.data, actor: target.actor }));
  }
  return written;
}
