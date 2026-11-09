import { Router } from "express";

import type { Queryable } from "../db";
import * as claims from "../repositories/claims";
import * as sessions from "../repositories/sessions";

/** GET /sessions/:id/claims?from&to: claims by stream time; an unverified claim has no time and is always included. */
export function claimsRouter({ db }: { db: Queryable }): Router {
  const router = Router();
  router.get("/:id/claims", async (req, res, next) => {
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
      res.json(await claims.list(db, session.id, { from, to }));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
