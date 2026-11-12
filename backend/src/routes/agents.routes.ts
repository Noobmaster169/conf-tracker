import { Router, type Response } from "express";
import { z } from "zod";

import type { AgentDefinition } from "../agents/agent";
import { listVersions, loadPrompt, overrideFor, shippedPrompt } from "../agents/prompts/registry";
import { agentById, AGENTS } from "../agents/registry";
import { type AgentCard, type AgentDetail, type RunSummary, slowMsFor, type WatchSettings } from "../contracts-agents";
import type { Queryable } from "../db";
import * as runs from "../repositories/agent-runs";
import * as settings from "../repositories/settings";

const STRIP = 24;
const refuse = (res: Response, status: number, error: string): void => void res.status(status).json({ error });
const limitOf = (value: unknown, fallback: number, max: number): number => Math.min(Math.max(Number(value) || fallback, 1), max);

/** What an agent's settings are now: for a video agent what a new video starts from, for the Watcher its own. */
async function storedSettings(db: Queryable, agent: AgentDefinition): Promise<Record<string, unknown>> {
  if (agent.settingsScope === "video") return settings.defaultConfig(db);
  return ((await settings.get<Record<string, unknown>>(db, "watcher"))?.value ?? {}) as Record<string, unknown>;
}

/** Each of its settings with the default, the stored value, and whether that value is one its schema takes. */
function settingRows(agent: AgentDefinition, stored: Record<string, unknown>): AgentDetail["settings"] {
  if (!agent.settings) return [];
  const defaults = agent.settings.parse({}) as Record<string, unknown>;
  return Object.keys(agent.settings.shape).map((key) => {
    const value = key in stored ? stored[key] : defaults[key];
    return { key, value, default: defaults[key], fixed_at_start: agent.fixedAtStart.includes(key), valid: agent.settings!.shape[key]!.safeParse(value).success };
  });
}

const textOf = (rows: AgentDetail["settings"], key: string | undefined): string | null => {
  const value = rows.find((row) => row.key === key)?.value;
  return typeof value === "string" ? value : null;
};

async function openIncidents(db: Queryable): Promise<Map<string, number>> {
  const { rows } = await db.query<{ agent_id: string; n: number }>(
    `select agent_id, count(*)::int as n from incidents where resolved_at is null and agent_id is not null group by agent_id`,
  );
  return new Map(rows.map((row) => [row.agent_id, row.n]));
}

async function cardOf(db: Queryable, agent: AgentDefinition, watch: WatchSettings, incidents: Map<string, number>, rows: AgentDetail["settings"]): Promise<AgentCard> {
  const recent = await runs.recentStatuses(db, agent.id, STRIP, slowMsFor(watch, agent.id));
  const last = recent.at(-1) ?? null;
  const open = incidents.get(agent.id) ?? 0;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    trigger: agent.trigger.text,
    internal: agent.internal,
    prompt_version: textOf(rows, agent.promptKey),
    model: textOf(rows, agent.modelKey),
    status: open > 0 || last?.status === "failed" ? "failed" : last?.status === "slow" ? "slow" : last ? "ok" : "idle",
    last_run_at: last?.at ?? null,
    recent: recent.map((run) => run.status),
    open_incidents: open,
  };
}

/** The versions of its instructions, and the one in use even when nobody has written it. */
function instructionsOf(agent: AgentDefinition, inUse: string | null): AgentDetail["instructions"] {
  const versions = listVersions(agent.id).map((version) => ({
    version,
    source: overrideFor(agent.id, version) ? (shippedPrompt(agent.id, version) ? ("registered over the file" as const) : ("registered" as const)) : ("file" as const),
    model: loadPrompt(agent.id, version).model,
    in_use: version === inUse,
    exists: true,
  }));
  if (inUse !== null && !versions.some((v) => v.version === inUse)) versions.unshift({ version: inUse, source: "file", model: "", in_use: true, exists: false });
  return versions;
}

/** A run as a list shows it, with the line its agent gives it. */
export async function summarise(db: Queryable, agent: AgentDefinition, rows: runs.RunRow[], slowMs: number): Promise<RunSummary[]> {
  const effects = await runs.effectsFor(db, rows.map((row) => row.id));
  return rows.map(({ parsed, step: _step, ...row }) => ({ ...row, status: runs.statusOf(row, slowMs), result: agent.describe({ error: row.error, parsed }, effects.get(row.id)!) }));
}

const CallsQuery = z.object({ session: z.uuid().optional(), before: z.coerce.number().int().positive().optional() });

/** The agents: who they are, how each is doing, and what each did. Reads only in this file's first part; writes follow. */
export function agentsRouter({ db }: { db: Queryable }): Router {
  const router = Router();

  router.get("/agents", async (_req, res, next) => {
    try {
      const [watch, incidents] = await Promise.all([settings.watchSettings(db), openIncidents(db)]);
      const cards: AgentCard[] = [];
      for (const agent of AGENTS) cards.push(await cardOf(db, agent, watch, incidents, settingRows(agent, await storedSettings(db, agent))));
      res.json(cards);
    } catch (error) {
      next(error);
    }
  });

  router.get("/agents/:id", async (req, res, next) => {
    try {
      const agent = agentById(req.params.id);
      if (!agent) return refuse(res, 404, "no such agent");
      const [watch, incidents, stored] = await Promise.all([settings.watchSettings(db), openIncidents(db), storedSettings(db, agent)]);
      const rows = settingRows(agent, stored);
      const card = await cardOf(db, agent, watch, incidents, rows);
      const detail: AgentDetail = { ...card, reads: agent.reads, writes: agent.writes, settings_scope: agent.settingsScope, settings: rows, instructions: instructionsOf(agent, card.prompt_version) };
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.get("/agents/:id/calls", async (req, res, next) => {
    try {
      const agent = agentById(req.params.id);
      if (!agent) return refuse(res, 404, "no such agent");
      const query = CallsQuery.safeParse(req.query);
      if (!query.success) return refuse(res, 400, `${query.error.issues[0]?.path.join(".")}: ${query.error.issues[0]?.message}`);
      const status = req.query.status === "failed" || req.query.status === "slow" ? req.query.status : undefined;
      const slowMs = slowMsFor(await settings.watchSettings(db), agent.id);
      const rows = await runs.listRuns(db, { agentId: agent.id, sessionId: query.data.session, before: query.data.before, status, limit: limitOf(req.query.limit, 50, 200), slowMs });
      res.json(await summarise(db, agent, rows, slowMs));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
