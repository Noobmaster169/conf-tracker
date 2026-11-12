import express, { type NextFunction, type Request, type Response } from "express";

import type { LlmClient } from "./agents/llm-client";
import { requireCaller } from "./auth";
import type { Queryable } from "./db";
import type { SessionRunner } from "./ingest/session-runner";
import type { WritePost } from "./ingest/poster";
import type { Summarize } from "./ingest/summarizer";
import { RetryableError, TerminalError, UpstreamError } from "./lib/errors";
import { childLogger } from "./lib/logger";
import type { Hub } from "./realtime/hub";
import { adminRouter } from "./routes/admin.routes";
import { agentsRouter } from "./routes/agents.routes";
import { callsRouter } from "./routes/calls.routes";
import { claimSearchRouter } from "./routes/claim-search.routes";
import { claimsRouter } from "./routes/claims.routes";
import { conferenceRouter } from "./routes/conference.routes";
import { correctionsRouter } from "./routes/corrections.routes";
import { eventsRouter } from "./routes/events.routes";
import { opsRouter, type Probe } from "./routes/ops.routes";
import { sessionsRouter } from "./routes/sessions.routes";
import { speakersRouter } from "./routes/speakers.routes";
import { stageControlRouter } from "./routes/stage-control.routes";
import { topicsRouter } from "./routes/topics.routes";

const log = childLogger({ module: "api" });

export interface AppDeps {
  db: Queryable;
  hub: Hub;
  runner: SessionRunner;
  summarize?: Summarize;
  /** Writes a talk's X post again (POST /talks/:id/post). Without it that route answers 409. */
  post?: WritePost;
  /** For running a stored call again (POST /calls/:id/rerun). Without it that route answers 503. */
  llm?: LlmClient;
  fetchTitle?: (url: string) => Promise<string | null>;
  /** How /ops/status asks the proxy and speech for their health. Tests give a fake. */
  probe?: Probe;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Unauthenticated: the compose healthcheck has no key.
  app.get("/health", async (_req, res) => {
    try {
      await deps.db.query("select 1");
      res.json({ status: "ok", live: deps.runner.live() });
    } catch (error) {
      res.status(503).json({ status: "down", error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use(requireCaller);
  app.use("/sessions", sessionsRouter(deps));
  app.use("/sessions", eventsRouter(deps));
  app.use("/sessions", stageControlRouter(deps));
  app.use("/sessions", speakersRouter(deps));
  app.use("/sessions", claimsRouter(deps));
  app.use("/sessions", topicsRouter(deps));
  app.use("/calls", callsRouter(deps));
  app.use("/claims", claimSearchRouter(deps));
  app.use(conferenceRouter(deps));
  app.use(adminRouter(deps));
  app.use(correctionsRouter(deps));
  app.use(opsRouter(deps));
  app.use(agentsRouter(deps));

  app.use(
    // Four parameters are what make Express treat this as an error handler.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      // A streaming route may fail after its headers went out; a second status would throw.
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof UpstreamError) {
        res.status(error.status).json({ error: error.message, retryable: error.retryable });
        return;
      }
      if (error instanceof TerminalError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof RetryableError) {
        res.status(503).json({ error: error.message, retryable: true });
        return;
      }
      log.error({ err: error instanceof Error ? error.stack : String(error) }, "unhandled");
      res.status(500).json({ error: "internal error" });
    },
  );

  return app;
}
