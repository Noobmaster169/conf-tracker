import { Router } from "express";

import type { Queryable } from "../db";
import * as claims from "../repositories/claims";
import * as sessions from "../repositories/sessions";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** GET /sessions/:id/topics?from&to&limit: topic counts over claims timed in the range, computed here so the page only draws them. */
export function topicsRouter({ db }: { db: Queryable }): Router {
  const router = Router();
  router.get("/:id/topics", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const from = Number(req.query.from ?? 0);
      const to = Number(req.query.to ?? Number.MAX_SAFE_INTEGER);
      const limit = Number(req.query.limit ?? DEFAULT_LIMIT);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        res.status(400).json({ error: "from and to must be numbers" });
        return;
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        res.status(400).json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` });
        return;
      }
      res.json({ from, to, topics: await claims.topicCounts(db, session.id, { from, to, limit }) });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
