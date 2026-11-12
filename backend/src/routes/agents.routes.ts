import { Router, type Response } from "express";
import { z } from "zod";

import type { AgentDefinition } from "../agents/agent";
import { type LlmClient, toOutputSchema } from "../agents/llm-client";
import { listVersions, loadPrompt, overrideFor, shippedPrompt } from "../agents/prompts/registry";
import { agentById, AGENTS } from "../agents/registry";
import { type ActivityLine, type AgentCard, type AgentDetail, type AgentEvent, type Rerun, type RunSummary, slowMsFor, WatchSettings } from "../contracts-agents";
import { actorOf } from "../auth";
import { atomic, type Queryable } from "../db";
import { mergeDefault, mergeSession, runningSessions } from "../ingest/config-patch";
import type { SessionRunner } from "../ingest/session-runner";
import { childLogger } from "../lib/logger";
import type { Hub } from "../realtime/hub";
import * as agentEvents from "../repositories/agent-events";
import * as runs from "../repositories/agent-runs";
import * as calls from "../repositories/calls";
import * as incidents from "../repositories/incidents";
import * as sessions from "../repositories/sessions";
import * as settings from "../repositories/settings";
import { configError } from "./sessions.routes";

const log = childLogger({ module: "agents" });

const STRIP = 24;
/** A rerun still pending after this was cut off by a restart: nothing is working on it. */
const RERUN_GIVE_UP_MS = 10 * 60 * 1000;
/** The aliases the proxy takes. A stored call names what the alias resolved to, which cannot be sent back. */
const MODEL_ALIASES = new Set(["haiku", "sonnet", "opus", "test"]);
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
    `select agent_id, count(*)::int as n from incidents where ${incidents.SHOWN_OPEN} and agent_id is not null group by agent_id`,
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

const RerunBody = z.object({ prompt_version: z.string().regex(/^v\d+$/).optional(), model: z.string().min(1).optional() });

/** A rerun as its event holds it. */
function toRerun(event: AgentEvent): Rerun {
  const data = (event.data ?? {}) as Partial<Rerun>;
  const stale = data.status === "pending" && Date.now() - Date.parse(event.created_at) > RERUN_GIVE_UP_MS;
  const version = data.prompt_version ?? "";
  return {
    id: event.id,
    call_id: event.call_id ?? 0,
    status: stale ? "failed" : (data.status ?? "pending"),
    prompt_version: version,
    model: data.model ?? "",
    output: data.output ?? null,
    parsed_ok: data.parsed_ok ?? null,
    error: stale ? "interrupted" : (data.error ?? null),
    latency_ms: data.latency_ms ?? null,
    note: `Uses the text of ${version} as it stands now.`,
  };
}

const SettingsBody = z.object({ set: z.record(z.string(), z.unknown()), apply: z.enum(["all", "new", "running"]).default("all") });
const CallsQuery = z.object({ session: z.uuid().optional(), before: z.coerce.number().int().positive().optional() });

/** The agents: who they are, how each is doing, and what each did. Reads only in this file's first part; writes follow. */
export function agentsRouter({ db, hub, runner, llm }: { db: Queryable; hub: Hub; runner: SessionRunner; llm?: LlmClient }): Router {
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
      const detail: AgentDetail = { ...card, reads: agent.reads, writes: agent.writes, settings_scope: agent.settingsScope, prompt_key: agent.promptKey ?? null, model_key: agent.modelKey ?? null, settings: rows, instructions: instructionsOf(agent, card.prompt_version) };
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

  // Changes an agent's settings where asked: what new videos start from, the videos running now, or both. Everything is
  // checked before anything is written, and the writes are one transaction: a refused change changes nothing.
  router.patch("/agents/:id/settings", async (req, res, next) => {
    try {
      const agent = agentById(req.params.id);
      if (!agent) return refuse(res, 404, "no such agent");
      const body = SettingsBody.safeParse(req.body);
      if (!body.success) return refuse(res, 400, `${body.error.issues[0]?.path.join(".") || "body"}: ${body.error.issues[0]?.message}`);
      const { set, apply } = body.data;
      const stranger = Object.keys(set).find((key) => !agent.settings || !(key in agent.settings.shape));
      if (stranger) return refuse(res, 400, `${stranger} is not one of ${agent.name}'s settings`);
      const actor = actorOf(req);

      if (agent.settingsScope === "global") {
        const stored = ((await settings.get<Record<string, unknown>>(db, "watcher"))?.value ?? {}) as Record<string, unknown>;
        const merged = mergeDefault(stored, set);
        const parsed = WatchSettings.safeParse(merged);
        if (!parsed.success) return refuse(res, 400, `${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
        if (!listVersions(agent.id).includes(parsed.data.watch_prompt)) return refuse(res, 400, `no ${agent.id} prompt ${parsed.data.watch_prompt}`);
        const changed = agentEvents.changeSummaries(stored, merged).length > 0;
        if (changed) {
          await atomic(db, async (tx) => {
            await settings.put(tx, "watcher", merged);
            await agentEvents.recordChanges(tx, stored, merged, { where: "for the whole app", actor });
          });
        }
        return void res.json({ default_changed: changed, sessions: [], waits_for_next_start: [] });
      }

      // Every target with what it holds now and what it would hold; only those that would really change are written.
      const storedDefault = await settings.defaultConfig(db);
      const mergedDefault = mergeDefault(storedDefault, set);
      const changeDefault = apply !== "running" && agentEvents.changeSummaries(storedDefault, mergedDefault).length > 0;
      const videos = apply === "new" ? [] : await runningSessions(db, runner);
      const targets = videos
        .map((session) => ({ session, merged: mergeSession(session.config, set) }))
        .filter(({ session, merged }) => agentEvents.changeSummaries(session.config, merged).length > 0);

      const refusedDefault = changeDefault ? configError(mergedDefault) : null;
      if (refusedDefault) return refuse(res, 400, refusedDefault);
      for (const { session, merged } of targets) {
        const refused = configError(merged);
        if (refused) return refuse(res, 400, `${refused} (on ${session.title ?? session.id})`);
      }
      // A value no target would change still has to be one the schema takes.
      const refusedAlone = configError(mergeDefault({}, set));
      if (refusedAlone) return refuse(res, 400, refusedAlone);

      const updated = await atomic(db, async (tx) => {
        if (changeDefault) {
          await settings.put(tx, "default_config", mergedDefault);
          await agentEvents.recordChanges(tx, storedDefault, mergedDefault, { where: "for new videos", actor });
        }
        const written = [];
        for (const { session, merged } of targets) {
          written.push(await sessions.setConfig(tx, session.id, merged));
          await agentEvents.recordChanges(tx, session.config, merged, { where: `on ${session.title ?? "an untitled video"}`, sessionId: session.id, actor });
        }
        return written;
      });
      for (const session of updated) hub.publish(session.id, { type: "session", data: session });
      res.json({
        default_changed: changeDefault,
        sessions: updated.map((session) => ({ id: session.id, title: session.title })),
        waits_for_next_start: updated.length > 0 ? Object.keys(set).filter((key) => agent.fixedAtStart.includes(key)) : [],
      });
    } catch (error) {
      next(error);
    }
  });

  // Sends a stored call again, with another version of the instructions or another model, to read what comes back. It
  // answers at once and works in the background: a model call can take minutes. Nothing is stored but the event: no
  // row in llm_calls (the extractor's cursor is its furthest answered call), no claims, names, timeline or summary.
  router.post("/calls/:id/rerun", async (req, res, next) => {
    try {
      const call = await calls.get(db, Number(req.params.id) || 0);
      if (!call) return refuse(res, 404, "call not found");
      const agent = agentById(call.step);
      // An agent that answers in free text fills its instructions with values that are not stored (the summarizer's word limits).
      if (!agent?.output) return refuse(res, 400, `run again is not offered for this agent${agent ? `: the ${agent.name} has its own way to write again` : ""}`);
      const body = RerunBody.safeParse(req.body ?? {});
      if (!body.success) return refuse(res, 400, `${body.error.issues[0]?.path.join(".") || "body"}: ${body.error.issues[0]?.message}`);
      const version = body.data.prompt_version ?? call.prompt_version;
      if (!listVersions(agent.id).includes(version)) return refuse(res, 400, `no ${agent.id} prompt ${version}`);
      if (!llm) return refuse(res, 503, "this api has no model client");
      const prompt = loadPrompt(agent.id, version);
      const model = body.data.model ?? (MODEL_ALIASES.has(call.model) ? call.model : prompt.model);
      // A retry's stored input already holds the first answer and its correction; the run's first attempt is what was asked.
      const firstId = (await runs.attemptsOf(db, call.id))[0] ?? call.id;
      const first = firstId === call.id ? call : ((await calls.get(db, firstId)) ?? call);
      const pending = { status: "pending" as const, prompt_version: version, model };
      const event = await agentEvents.add(db, { agentId: agent.id, sessionId: call.session_id, callId: call.id, kind: "rerun", summary: `Run again with ${version} on ${model}`, data: pending, actor: actorOf(req) });
      res.status(202).json(toRerun(event));

      const outputSchema = toOutputSchema(agent.output);
      const output = agent.output;
      void (async () => {
        const started = Date.now();
        try {
          const answer = await llm.complete({ model, system: prompt.text.replace("{{schema}}", JSON.stringify(outputSchema, null, 2)), user: first.input, maxTokens: prompt.maxTokens, outputSchema });
          let parsed: unknown;
          try {
            parsed = JSON.parse(answer.text);
          } catch {
            parsed = undefined;
          }
          await agentEvents.setData(db, event.id, { ...pending, status: "done", output: answer.text, parsed_ok: output.safeParse(parsed).success, latency_ms: answer.latencyMs });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await agentEvents.setData(db, event.id, { ...pending, status: "failed", error: message, latency_ms: Date.now() - started }).catch((inner) => log.warn({ err: String(inner) }, "a rerun's failure could not be stored"));
        }
      })();
    } catch (error) {
      next(error);
    }
  });

  router.get("/reruns/:id", async (req, res, next) => {
    try {
      const event = await agentEvents.get(db, Number(req.params.id) || 0);
      if (!event || event.kind !== "rerun") return refuse(res, 404, "no such rerun");
      res.json(toRerun(event));
    } catch (error) {
      next(error);
    }
  });

  // What it did and what was done to it, in one line of time: its runs and its events, newest first.
  router.get("/agents/:id/activity", async (req, res, next) => {
    try {
      const agent = agentById(req.params.id);
      if (!agent) return refuse(res, 404, "no such agent");
      const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before).toISOString() : undefined;
      const limit = limitOf(req.query.limit, 50, 200);
      const slowMs = slowMsFor(await settings.watchSettings(db), agent.id);
      const [made, done] = await Promise.all([
        summarise(db, agent, await runs.listRuns(db, { agentId: agent.id, beforeTime: before, limit, slowMs }), slowMs),
        agentEvents.list(db, { agentId: agent.id, before, limit }),
      ]);
      const lines: ActivityLine[] = [
        ...made.map((run) => ({ at: run.created_at, kind: "call" as const, summary: run.result, actor: null, call_id: run.id, status: run.status })),
        ...done.map((event) => ({ at: event.created_at, kind: event.kind, summary: event.summary, actor: event.actor, call_id: event.call_id, status: null })),
      ];
      res.json(lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit));
    } catch (error) {
      next(error);
    }
  });

  // What the Watcher found: open ones first. `open=1` leaves out what went away or was marked resolved.
  router.get("/incidents", async (req, res, next) => {
    try {
      const agent = typeof req.query.agent === "string" && req.query.agent ? req.query.agent : undefined;
      res.json(await incidents.list(db, { open: req.query.open === "1" || req.query.open === "true", agentId: agent, limit: limitOf(req.query.limit, 50, 200) }));
    } catch (error) {
      next(error);
    }
  });

  // Marked resolved by hand. It stays the open record of that trouble, so it is not reported again while it lasts.
  router.post("/incidents/:id/resolve", async (req, res, next) => {
    try {
      const incident = await incidents.resolve(db, Number(req.params.id) || 0);
      if (!incident) return refuse(res, 404, "no such incident");
      res.json(incident);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
