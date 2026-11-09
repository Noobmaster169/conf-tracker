import { Router } from "express";

import { listVersions } from "../agents/prompts/registry";
import { CreateSessionBody, ExtractConfig, NameConfig, ReplayBody } from "../contracts";
import type { Queryable } from "../db";
import type { SessionRunner } from "../ingest/session-runner";
import { replayConfig } from "../lib/replay-config";
import { videoIdFromUrl } from "../lib/youtube-id";
import type { Hub } from "../realtime/hub";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import { buildSnapshot } from "./snapshot";

export interface SessionsDeps {
  db: Queryable;
  hub: Hub;
  runner: SessionRunner;
}

/** The same checks for a new session and a replay: a bad key or an unknown prompt version is named in the refusal. */
function configError(config: Record<string, unknown>): string | null {
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
  return null;
}

export function sessionsRouter({ db, hub, runner }: SessionsDeps): Router {
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
      const config = { ...(body.data.config ?? {}), ...(body.data.speed !== undefined ? { speed: body.data.speed } : {}) };
      const refused = configError(config);
      if (refused) {
        res.status(400).json({ error: refused });
        return;
      }
      const created = await sessions.create(db, { sourceUrl: body.data.url ?? null, sourceFile: body.data.file ?? null, config });
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
      const created = await sessions.create(db, { sourceUrl: original.source_url, sourceFile: original.source_file, config, replayOf: original.id });
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

  return router;
}
