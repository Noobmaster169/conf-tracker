import { Router, type Response } from "express";
import { Pool } from "pg";
import { z } from "zod";

import { listSteps, listVersions, loadPrompt, overrideFor, setOverrides, shippedPrompt } from "../agents/prompts/registry";
import { actorOf } from "../auth";
import { ExtractConfig, NameConfig, SummaryConfig, TrackConfig } from "../contracts";
import type { Queryable } from "../db";
import type { SessionRunner } from "../ingest/session-runner";
import { httpProbe, type Probe, proxyHealthUrl, speechHealthUrl } from "../lib/health";
import { recentLogs } from "../lib/logger";
import { mergeDefault, mergeSession } from "../ingest/config-patch";
import type { Hub } from "../realtime/hub";
import * as agentEvents from "../repositories/agent-events";
import * as jobs from "../repositories/ops-jobs";
import * as promptOverrides from "../repositories/prompt-overrides";
import * as sessions from "../repositories/sessions";
import * as settings from "../repositories/settings";
import { configError } from "./sessions.routes";

export { httpProbe, type Probe } from "../lib/health";

/**
 * What the box does when asked (deploy/box-ops.py holds the same list and is the one that enforces it). Nothing here is
 * a shell: each verb is one fixed action.
 */
export const JOB_VERBS = {
  ps: "the stack's containers",
  logs: 'a container\'s newest log lines: { "service": "api|llm-proxy|web|postgres", "lines": 200 }',
  tail: 'the end of a log file on the box: { "file": "deploy|ngrok|speech", "lines": 100 }',
  resources: "disk, memory, GPU, the recordings' size and docker's disk use",
  restart: 'restarts one container: { "service": "api|llm-proxy|web|postgres" }. Restarting api ends every running video; it needs "force": true while one runs',
  "deploy-now": "lets the next deploy restart the api even while a video is running (it is held back otherwise)",
  redeploy: "forgets what is deployed, so the next pass rebuilds every image from main",
  "set-env": 'changes one value in the box\'s .env and restarts what reads it: { "key": "CLAUDE_CODE_OAUTH_TOKEN|LOG_LEVEL|ACCESS_PASSWORD", "value": "..." }',
  prune: "removes this stack's unused images and old build cache",
  "ngrok-restart": "restarts the tunnel; the public URL is unreachable for a few seconds",
  "speech-restart": 'restarts the shared speech service, ending EVERY running video of this stack and of yt-stream: needs { "confirm": "ends-every-running-video" }',
  "recordings-clean": 'deletes the kept audio of finished videos, which ends their replays: { "session_ids": ["..."] }',
} as const;

const JobBody = z.object({ verb: z.string(), args: z.record(z.string(), z.unknown()).default({}) });
const ResultBody = z.object({ ok: z.boolean(), output: z.string().max(400_000).default("") });
const PromptBody = z.object({ text: z.string().min(1).max(200_000), model: z.string().min(1).optional(), max_tokens: z.number().int().positive().optional() });
const SqlBody = z.object({ sql: z.string().min(1).max(20_000) });
const ConfigBody = z.record(z.string(), z.unknown());

const STARTED_AT = new Date();
const refuse = (res: Response, status: number, error: string): void => void res.status(status).json({ error });

/** Every setting a video's config can hold with its default, so nobody has to read the code to know the keys. */
function configDefaults(): Record<string, unknown> {
  return { ...ExtractConfig.parse({}), ...NameConfig.parse({}), ...TrackConfig.parse({}), ...SummaryConfig.parse({}) };
}

/** Rows of a read-only statement. On the pool it runs in a read-only transaction with a time limit, so it cannot write or hang. */
async function readOnly(db: Queryable, sql: string): Promise<{ rows: unknown[]; truncated: boolean }> {
  const LIMIT = 500;
  const cut = (rows: unknown[]) => ({ rows: rows.slice(0, LIMIT), truncated: rows.length > LIMIT });
  if (!(db instanceof Pool)) return cut((await db.query(sql)).rows);
  const client = await db.connect();
  try {
    await client.query("begin read only");
    await client.query("set local statement_timeout = 8000");
    return cut((await client.query(sql)).rows);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

/**
 * Running the stack from outside the box: what is deployed and healthy, the api's own log, jobs for the box to run,
 * prompts and settings that change without a build, and read-only SQL. deploy/README.md, "Without the box".
 */
export function opsRouter({ db, hub, runner, probe = httpProbe }: { db: Queryable; hub: Hub; runner: SessionRunner; probe?: Probe }): Router {
  const router = Router();

  router.get("/ops/status", async (_req, res, next) => {
    try {
      const [proxy, speech, calls, box, recent] = await Promise.all([
        probe(proxyHealthUrl()),
        probe(speechHealthUrl()),
        jobs.callHealth(db, 60),
        settings.get<Record<string, unknown>>(db, "box_report"),
        jobs.list(db, 5),
      ]);
      const boxAge = box ? Math.round((Date.now() - Date.parse(box.updated_at)) / 1000) : null;
      res.json({
        api: { started_at: STARTED_AT.toISOString(), uptime_s: Math.round((Date.now() - STARTED_AT.getTime()) / 1000), live: runner.live() },
        llm_proxy: proxy,
        speech,
        calls_last_hour: calls,
        // The box reports on every cron pass (three minutes). Much older than that and the cron, the deploy script or the box is in trouble.
        box: box ? { age_s: boxAge, stale: boxAge !== null && boxAge > 600, ...box.value } : null,
        recent_jobs: recent.map(({ id, verb, status, created_at, finished_at }) => ({ id, verb, status, created_at, finished_at })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/ops/logs", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 3000);
    const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
    res.json(recentLogs({ limit, level: text(req.query.level), module: text(req.query.module), contains: text(req.query.contains) }));
  });

  // The box's report of itself, posted by deploy/box-ops.py on every cron pass.
  router.post("/ops/box-report", async (req, res, next) => {
    try {
      if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) return refuse(res, 400, "body: expected an object");
      await settings.put(db, "box_report", req.body);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/ops/jobs/verbs", (_req, res) => void res.json(JOB_VERBS));

  router.post("/ops/jobs", async (req, res, next) => {
    try {
      const body = JobBody.safeParse(req.body);
      if (!body.success) return refuse(res, 400, body.error.issues[0]?.message ?? "invalid body");
      const { verb, args } = body.data;
      if (!(verb in JOB_VERBS)) return refuse(res, 400, `no such verb; one of: ${Object.keys(JOB_VERBS).join(", ")}`);
      const live = runner.live();
      if (verb === "restart" && args.service === "api" && live.length > 0 && args.force !== true) {
        return refuse(res, 409, `${live.length} video(s) running; restarting the api ends them. Send "force": true to do it anyway`);
      }
      if (verb === "set-env" && args.key === "LOG_LEVEL" && live.length > 0 && args.force !== true) {
        return refuse(res, 409, `${live.length} video(s) running; LOG_LEVEL restarts the api, which ends them. Send "force": true to do it anyway`);
      }
      if (verb === "speech-restart" && args.confirm !== "ends-every-running-video") {
        return refuse(res, 400, 'speech is shared with yt-stream; send "confirm": "ends-every-running-video"');
      }
      if (verb === "recordings-clean") {
        const ids = z.array(z.uuid()).min(1).max(200).safeParse(args.session_ids);
        if (!ids.success) return refuse(res, 400, "session_ids: a list of this stack's video ids");
        for (const id of ids.data) {
          const session = await sessions.get(db, id);
          if (!session) return refuse(res, 400, `${id} is not a video of this stack`);
          if (live.includes(id) || session.status === "starting" || session.status === "live") return refuse(res, 409, `${id} is still running`);
        }
      }
      res.status(201).json(await jobs.create(db, verb, args));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ops/jobs", async (req, res, next) => {
    try {
      res.json(await jobs.list(db, Math.min(Math.max(Number(req.query.limit) || 20, 1), 200)));
    } catch (error) {
      next(error);
    }
  });

  // The box takes the oldest queued job. 204 when there is none.
  router.post("/ops/jobs/claim", async (_req, res, next) => {
    try {
      const job = await jobs.claim(db);
      if (!job) return void res.status(204).end();
      res.json(job);
    } catch (error) {
      next(error);
    }
  });

  router.get("/ops/jobs/:id", async (req, res, next) => {
    try {
      const job = await jobs.get(db, Number(req.params.id) || 0);
      if (!job) return refuse(res, 404, "job not found");
      res.json(job);
    } catch (error) {
      next(error);
    }
  });

  router.post("/ops/jobs/:id/result", async (req, res, next) => {
    try {
      const body = ResultBody.safeParse(req.body);
      if (!body.success) return refuse(res, 400, body.error.issues[0]?.message ?? "invalid body");
      const job = await jobs.finish(db, Number(req.params.id) || 0, body.data.ok, body.data.output);
      if (!job) return refuse(res, 404, "no running job with that id");
      res.json(job);
    } catch (error) {
      next(error);
    }
  });

  // Every step's versions, where each comes from, and which one a new video uses.
  router.get("/ops/prompts", async (_req, res, next) => {
    try {
      const defaults = { ...configDefaults(), ...(await settings.defaultConfig(db)) } as Record<string, unknown>;
      const key: Record<string, string> = { extract: "extract_prompt", name: "name_prompt", track: "track_prompt", summarize: "summary_prompt" };
      res.json(
        listSteps().map((step) => ({
          step,
          default: defaults[key[step] ?? ""] ?? null,
          versions: listVersions(step).map((version) => ({
            version,
            source: overrideFor(step, version) ? (shippedPrompt(step, version) ? "registered over the file" : "registered") : "file",
            model: loadPrompt(step, version).model,
          })),
        })),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/ops/prompts/:step/:version", (req, res, next) => {
    try {
      const { step, version } = req.params;
      if (!listSteps().includes(step) || !listVersions(step).includes(version)) return refuse(res, 404, "no such prompt");
      res.json({ ...loadPrompt(step, version), registered: overrideFor(step, version) !== null });
    } catch (error) {
      next(error);
    }
  });

  // Registers a prompt version without a build. A running video uses it once its config names it (PATCH /sessions/:id/config).
  router.put("/ops/prompts/:step/:version", async (req, res, next) => {
    try {
      const { step, version } = req.params;
      if (!listSteps().includes(step)) return refuse(res, 404, `no step ${step}; one of: ${listSteps().join(", ")}`);
      if (!/^v\d+$/.test(version)) return refuse(res, 400, "version: like v6");
      const body = PromptBody.safeParse(req.body);
      if (!body.success) return refuse(res, 400, `${body.error.issues[0]?.path.join(".") || "body"}: ${body.error.issues[0]?.message}`);
      const shipped = shippedPrompt(step, version);
      const newest = loadPrompt(step, listVersions(step)[0]!);
      // The pipeline fills {{schema}} into every prompt that has it; a text without the slot gets answers it cannot read.
      if (newest.text.includes("{{schema}}") && !body.data.text.includes("{{schema}}")) return refuse(res, 400, "text: this step's prompts carry a {{schema}} slot; keep it");
      const maxTokens = body.data.max_tokens ?? shipped?.maxTokens ?? newest.maxTokens;
      const replaced = overrideFor(step, version);
      const saved = await promptOverrides.put(db, {
        step, version, model: body.data.model ?? shipped?.model ?? newest.model, text: body.data.text.trim(), ...(maxTokens === undefined ? {} : { maxTokens }),
      });
      setOverrides(await promptOverrides.list(db));
      // A registered version can be written over in place, so the record keeps the text that was there.
      await agentEvents.add(db, {
        agentId: step, kind: "change", actor: actorOf(req),
        summary: `Instructions ${version} ${replaced ? "overwritten" : "registered"}`, data: replaced ? { before: replaced.text } : {},
      });
      res.json({ ...saved, registered: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/ops/prompts/:step/:version", async (req, res, next) => {
    try {
      if (!(await promptOverrides.remove(db, req.params.step, req.params.version))) return refuse(res, 404, "no registered prompt with that step and version");
      setOverrides(await promptOverrides.list(db));
      await agentEvents.add(db, { agentId: req.params.step, kind: "change", actor: actorOf(req), summary: `Instructions ${req.params.version} handed back to the file` });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // What a new video's config starts from: the code's defaults, and what has been set over them.
  router.get("/ops/config", async (_req, res, next) => {
    try {
      res.json({ code_defaults: configDefaults(), set: await settings.defaultConfig(db) });
    } catch (error) {
      next(error);
    }
  });

  // Merged into what is set; a null value takes the key back to the code's default. Applies to videos started after this.
  router.patch("/ops/config", async (req, res, next) => {
    try {
      const body = ConfigBody.safeParse(req.body);
      if (!body.success) return refuse(res, 400, "body: expected an object of settings");
      const stored = await settings.defaultConfig(db);
      const merged = mergeDefault(stored, body.data);
      const refused = configError(merged);
      if (refused) return refuse(res, 400, refused);
      const saved = (await settings.put(db, "default_config", merged)).value;
      await agentEvents.recordChanges(db, stored, merged, { where: "for new videos", actor: actorOf(req) });
      res.json({ code_defaults: configDefaults(), set: saved });
    } catch (error) {
      next(error);
    }
  });

  // Changes a video's settings, running or not; a null value takes the key back to its default. A running video's
  // loops read them at their next run. Intervals and on/off switches are fixed when a video starts.
  router.patch("/sessions/:id/config", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) return refuse(res, 404, "session not found");
      const body = ConfigBody.safeParse(req.body);
      if (!body.success) return refuse(res, 400, "body: expected an object of settings");
      const merged = mergeSession(session.config, body.data);
      const refused = configError(merged);
      if (refused) return refuse(res, 400, refused);
      const updated = await sessions.setConfig(db, session.id, merged);
      await agentEvents.recordChanges(db, session.config, merged, { where: `on ${session.title ?? "an untitled video"}`, sessionId: session.id, actor: actorOf(req) });
      hub.publish(session.id, { type: "session", data: updated });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // Any read of the database, for finding out what happened. It cannot write.
  router.post("/ops/sql", async (req, res, next) => {
    try {
      const body = SqlBody.safeParse(req.body);
      if (!body.success) return refuse(res, 400, "sql: a statement to read with");
      try {
        res.json(await readOnly(db, body.data.sql));
      } catch (error) {
        refuse(res, 400, error instanceof Error ? error.message : String(error));
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}
