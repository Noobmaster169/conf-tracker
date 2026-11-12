import { Router } from "express";

import { NO_EFFECTS } from "../agents/agent";
import { agentById } from "../agents/registry";
import { slowMsFor } from "../contracts-agents";
import type { LlmCall } from "../contracts";
import type { Queryable } from "../db";
import * as agentEvents from "../repositories/agent-events";
import * as runs from "../repositories/agent-runs";
import * as calls from "../repositories/calls";
import * as claims from "../repositories/claims";
import * as names from "../repositories/names";
import * as settings from "../repositories/settings";

/**
 * GET /calls/:id: the whole call (input, output, parse result, tokens, cost, latency), the claims or name proposals it
 * produced, the line its agent gives it, and every attempt of the run it belongs to, oldest first.
 */
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
      const agent = agentById(call.step);
      const effects = (await runs.effectsFor(db, [call.id])).get(call.id) ?? NO_EFFECTS;
      const attempts: LlmCall[] = [];
      for (const attemptId of await runs.attemptsOf(db, call.id)) {
        const attempt = attemptId === call.id ? call : await calls.get(db, attemptId);
        if (attempt) attempts.push(attempt);
      }
      res.json({
        call,
        claims: await claims.forCall(db, call.id),
        proposals: await names.forCall(db, call.id),
        result: agent ? agent.describe(call, effects) : call.error ? `Failed: ${call.error.slice(0, 80)}` : "Answered",
        status: runs.statusOf(call, slowMsFor(await settings.watchSettings(db), call.step)),
        attempts,
        events: await agentEvents.list(db, { callId: call.id, limit: 50 }),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
