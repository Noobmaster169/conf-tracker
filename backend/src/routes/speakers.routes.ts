import { Router } from "express";

import type { Queryable } from "../db";
import * as diarization from "../repositories/diarization";
import * as names from "../repositories/names";
import * as sessions from "../repositories/sessions";
import * as speakers from "../repositories/speakers";

/** GET /sessions/:id/speakers/:sid: the registry row, the windows whose scores put this label there, and the names proposed for it. */
export function speakersRouter({ db }: { db: Queryable }): Router {
  const router = Router();
  router.get("/:id/speakers/:sid", async (req, res, next) => {
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const speaker = await speakers.get(db, session.id, req.params.sid);
      if (!speaker) {
        res.status(404).json({ error: "speaker not found" });
        return;
      }
      res.json({
        speaker,
        windows: await diarization.windowsFor(db, session.id, speaker.speaker_id),
        proposals: await names.forSpeaker(db, session.id, speaker.speaker_id),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
