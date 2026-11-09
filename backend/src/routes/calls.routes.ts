import { Router } from "express";

import type { Queryable } from "../db";
import * as calls from "../repositories/calls";
import * as claims from "../repositories/claims";
import * as names from "../repositories/names";

/** GET /calls/:id: the whole call (input, output, parse result, tokens, cost, latency) and the claims or name proposals it produced. */
export function callsRouter({ db }: { db: Queryable }): Router {
  const router = Router();
  router.get("/:id", async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const call = Number.isInteger(id) && id > 0 ? await calls.get(db, id) : null;
      if (!call) {
        res.status(404).json({ error: "call not found" });
        return;
      }
      res.json({ call, claims: await claims.forCall(db, call.id), proposals: await names.forCall(db, call.id) });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
