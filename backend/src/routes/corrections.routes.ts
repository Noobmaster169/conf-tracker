import { Router, type Response } from "express";
import type { z } from "zod";

import { ClaimPatch, SessionPatch, SpeakerCorrection } from "../contracts";
import { atomic, type Queryable } from "../db";
import type { SessionRunner } from "../ingest/session-runner";
import { resolveId } from "../pipeline/naming";
import type { Hub } from "../realtime/hub";
import * as claims from "../repositories/claims";
import * as people from "../repositories/people";
import * as sessions from "../repositories/sessions";
import * as speakers from "../repositories/speakers";
import * as stages from "../repositories/stages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function body<T>(schema: z.ZodType<T>, raw: unknown, res: Response): T | null {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  res.status(400).json({ error: `${issue?.path.join(".") || "body"}: ${issue?.message}` });
  return null;
}

const refuse = (res: Response, status: number, error: string): void => void res.status(status).json({ error });

/**
 * Putting right by hand what the pipeline got wrong, so nothing needs the database: who a voice is, what a claim says,
 * and taking out a claim, a video or a stage that should not be there. Every delete here is for good.
 */
export function correctionsRouter({ db, hub, runner }: { db: Queryable; hub: Hub; runner: SessionRunner }): Router {
  const router = Router();

  // Who a voice is. Every claim and transcript line of that voice follows, since they are read through it.
  router.put("/sessions/:id/speakers/:sid", async (req, res, next) => {
    try {
      const session = UUID.test(req.params.id) ? await sessions.get(db, req.params.id) : null;
      if (!session) return refuse(res, 404, "session not found");
      const speaker = await speakers.get(db, session.id, req.params.sid);
      if (!speaker) return refuse(res, 404, "speaker not found");
      const input = body(SpeakerCorrection, req.body, res);
      if (!input) return;

      if (input.merge_into !== undefined) {
        const roster = await speakers.list(db, session.id);
        if (!roster.some((s) => s.speaker_id === input.merge_into)) return refuse(res, 400, `no speaker ${input.merge_into} in this video`);
        const into = resolveId(roster, input.merge_into);
        if (into === resolveId(roster, speaker.speaker_id)) return refuse(res, 400, `${speaker.speaker_id} and ${input.merge_into} are already one speaker`);
        const changed = await atomic(db, async (tx) => {
          const merged = await speakers.markMerged(tx, session.id, speaker.speaker_id, into);
          const survivor = await speakers.inheritName(tx, session.id, speaker.speaker_id, into);
          return [merged, survivor ?? (await speakers.get(tx, session.id, into))];
        });
        for (const row of changed) if (row) hub.publish(session.id, { type: "speaker", data: row });
        return void res.json(changed[0]);
      }

      if (input.name === null) {
        const cleared = await speakers.clearName(db, session.id, speaker.speaker_id);
        if (cleared) hub.publish(session.id, { type: "speaker", data: cleared });
        return void res.json(cleared);
      }

      const person =
        input.person_id !== undefined
          ? await people.get(db, input.person_id)
          : await people.upsertByName(db, { name: input.name!, org: input.org ?? null, title: input.title ?? null });
      if (!person) return refuse(res, 400, "no such person");
      const role = [person.title, person.org].filter(Boolean).join(", ") || null;
      const named = await speakers.assign(db, session.id, speaker.speaker_id, person, role);
      hub.publish(session.id, { type: "person", data: person });
      if (named) hub.publish(session.id, { type: "speaker", data: named });
      res.json(named);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/claims/:id", async (req, res, next) => {
    try {
      const claim = await claims.get(db, Number(req.params.id) || 0);
      if (!claim) return refuse(res, 404, "claim not found");
      const input = body(ClaimPatch, req.body, res);
      if (!input) return;
      if (typeof input.speaker_id === "string" && !(await speakers.get(db, claim.session_id, input.speaker_id))) {
        return refuse(res, 400, `no speaker ${input.speaker_id} in this claim's video`);
      }
      res.json(await claims.change(db, claim.id, input));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/claims/:id", async (req, res, next) => {
    try {
      if (!(await claims.remove(db, Number(req.params.id) || 0))) return refuse(res, 404, "claim not found");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.patch("/sessions/:id", async (req, res, next) => {
    try {
      const session = UUID.test(req.params.id) ? await sessions.get(db, req.params.id) : null;
      if (!session) return refuse(res, 404, "session not found");
      const input = body(SessionPatch, req.body, res);
      if (!input) return;
      const updated = await sessions.setTitle(db, session.id, input.title);
      hub.publish(session.id, { type: "session", data: updated });
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  // A video that is running is stopped first; one that has replays loses them first, each on its own.
  router.delete("/sessions/:id", async (req, res, next) => {
    try {
      const session = UUID.test(req.params.id) ? await sessions.get(db, req.params.id) : null;
      if (!session) return refuse(res, 404, "session not found");
      if (runner.live().includes(session.id) || session.status === "starting" || session.status === "live") {
        return refuse(res, 409, "session is still running; stop it first");
      }
      const replays = await sessions.replayCount(db, session.id);
      if (replays > 0) return refuse(res, 409, `session has ${replays} replay${replays === 1 ? "" : "s"}; delete ${replays === 1 ? "it" : "them"} first`);
      await atomic(db, (tx) => sessions.remove(tx, session.id));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/stages/:id", async (req, res, next) => {
    try {
      const removed = UUID.test(req.params.id) ? await atomic(db, (tx) => stages.remove(tx, req.params.id)) : null;
      if (removed === null) return refuse(res, 404, "stage not found");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
