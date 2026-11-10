import { Router } from "express";

import { NowBody } from "../contracts";
import type { Queryable } from "../db";
import type { Hub } from "../realtime/hub";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import * as spans from "../repositories/spans";
import * as stages from "../repositories/stages";
import * as talks from "../repositories/talks";

/** The admin's hold on a video's place in the schedule: which stage it is, and what is on stage now. */
export function stageControlRouter({ db, hub }: { db: Queryable; hub: Hub }): Router {
  const router = Router();

  // The admin binds a video to a stage after the fact, or frees it with null.
  router.post("/:id/stage", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      const stageId: unknown = req.body?.stage_id ?? null;
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (stageId !== null && (typeof stageId !== "string" || !(await stages.get(db, stageId)))) {
        res.status(400).json({ error: "no such stage" });
        return;
      }
      const updated = await sessions.setStage(db, session.id, stageId);
      hub.publish(session.id, { type: "session", data: updated });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // The admin says what is on stage: from `t`, or from the newest transcript line. The tracker carries on from this belief.
  router.post("/:id/now", async (req, res, next) => {
    try {
      const body = NowBody.safeParse(req.body);
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message ?? "invalid body" });
        return;
      }
      const talk = body.data.talk_id === null ? null : await talks.get(db, body.data.talk_id);
      if (body.data.talk_id !== null && talk?.stage_id !== session.stage_id) {
        res.status(400).json({ error: "that talk is not on this video's stage" });
        return;
      }
      const t = body.data.t ?? (await segments.lastUpTo(db, session.id, Number.POSITIVE_INFINITY))?.t1 ?? 0;
      const { closed, opened } = await spans.switchTo(db, session.id, {
        talkId: talk?.id ?? null, state: talk ? "talk" : "break", t, confidence: null, quote: null, source: "admin", callId: null,
      });
      if (closed) hub.publish(session.id, { type: "span", data: closed });
      hub.publish(session.id, { type: "span", data: opened });
      res.json(opened);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
