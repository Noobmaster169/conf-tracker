import { Router } from "express";

import { listVersions } from "../agents/prompts/registry";
import { CreateSessionBody, ExtractConfig, NameConfig, PostConfig, ReplayBody, SummaryConfig, TrackConfig } from "../contracts";
import type { Queryable } from "../db";
import type { SessionRunner } from "../ingest/session-runner";
import { replayConfig } from "../lib/replay-config";
import { videoIdFromUrl } from "../lib/youtube-id";
import type { Hub } from "../realtime/hub";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import * as settings from "../repositories/settings";
import * as stages from "../repositories/stages";
import { buildSnapshot } from "./snapshot";

export interface SessionsDeps {
  db: Queryable;
  hub: Hub;
  runner: SessionRunner;
  /** The video's title from YouTube, for the cards. Absent in tests; a failure is a video without a title, never a refusal. */
  fetchTitle?: (url: string) => Promise<string | null>;
}

/** The same checks for a new session and a replay: a bad key or an unknown prompt version is named in the refusal. */
export function configError(config: Record<string, unknown>): string | null {
  const extract = ExtractConfig.safeParse(config);
  if (!extract.success) {
    const issue = extract.error.issues[0];
    return `config.${issue?.path.join(".")}: ${issue?.message}`;
  }
  if (!listVersions("extract").includes(extract.data.extract_prompt)) return `no extract prompt ${extract.data.extract_prompt}`;
  const naming = NameConfig.safeParse(config);
  if (!naming.success) {
    const issue = naming.error.issues[0];
    return `config.${issue?.path.join(".")}: ${issue?.message}`;
  }
  if (!listVersions("name").includes(naming.data.name_prompt)) return `no name prompt ${naming.data.name_prompt}`;
  const track = TrackConfig.safeParse(config);
  if (!track.success) return `config.${track.error.issues[0]?.path.join(".")}: ${track.error.issues[0]?.message}`;
  if (!listVersions("track").includes(track.data.track_prompt)) return `no track prompt ${track.data.track_prompt}`;
  const summary = SummaryConfig.safeParse(config);
  if (!summary.success) return `config.${summary.error.issues[0]?.path.join(".")}: ${summary.error.issues[0]?.message}`;
  if (!listVersions("summarize").includes(summary.data.summary_prompt)) return `no summarize prompt ${summary.data.summary_prompt}`;
  const post = PostConfig.safeParse(config);
  if (!post.success) return `config.${post.error.issues[0]?.path.join(".")}: ${post.error.issues[0]?.message}`;
  if (!listVersions("post").includes(post.data.post_prompt)) return `no post prompt ${post.data.post_prompt}`;
  return null;
}

export function sessionsRouter({ db, hub, runner, fetchTitle }: SessionsDeps): Router {
  const router = Router();

  router.post("/", async (req, res, next) => {
    try {
      const body = CreateSessionBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message ?? "invalid body" });
        return;
      }
      if (body.data.url && !videoIdFromUrl(body.data.url)) {
        res.status(400).json({ error: "not a YouTube video URL" });
        return;
      }
      // What has been set as the starting point (PATCH /ops/config), then what this request asks for.
      const config = { ...(await settings.defaultConfig(db)), ...(body.data.config ?? {}), ...(body.data.speed !== undefined ? { speed: body.data.speed } : {}) };
      const refused = configError(config);
      if (refused) {
        res.status(400).json({ error: refused });
        return;
      }
      if (body.data.stage_id && !(await stages.get(db, body.data.stage_id))) {
        res.status(400).json({ error: "no such stage" });
        return;
      }
      const title = body.data.url && fetchTitle ? await fetchTitle(body.data.url) : null;
      const created = await sessions.create(db, { sourceUrl: body.data.url ?? null, sourceFile: body.data.file ?? null, config, stageId: body.data.stage_id ?? null, title });
      res.status(201).json(await runner.start(created.id));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/replay", async (req, res, next) => {
    try {
      const body = ReplayBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message ?? "invalid body" });
        return;
      }
      const original = await sessions.get(db, req.params.id);
      if (!original) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // Its recording is still growing: a replay would stop wherever the file happened to end.
      if (original.status === "starting" || original.status === "live") {
        res.status(409).json({ error: "session is still running" });
        return;
      }
      const config = replayConfig(original.config, body.data.speed ?? 0, body.data.config ?? {});
      const refused = configError(config);
      if (refused) {
        res.status(400).json({ error: refused });
        return;
      }
      const created = await sessions.create(db, { sourceUrl: original.source_url, sourceFile: original.source_file, config, replayOf: original.id, stageId: original.stage_id, title: original.title });
      res.status(201).json(await runner.start(created.id));
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await sessions.list(db));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json(await buildSnapshot(db, hub, session));
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/transcript", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const from = Number(req.query.from ?? 0);
      const to = Number(req.query.to ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        res.status(400).json({ error: "from and to must be numbers" });
        return;
      }
      res.json(await segments.list(db, session.id, { from, to }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/stop", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json(await runner.stop(session.id));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/resume", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (session.status !== "degraded" && session.status !== "stopped") {
        res.status(409).json({ error: "video is already running" });
        return;
      }
      res.status(201).json(await runner.resume(session.id));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
