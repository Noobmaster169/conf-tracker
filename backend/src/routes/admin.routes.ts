import { Router, type Response } from "express";
import { z } from "zod";

import { ImportBody, PersonBody, PhotoBody, StageBody, TalkBody } from "../contracts";
import type { StageWithTalks } from "../contracts-views";
import type { Queryable } from "../db";
import type { WritePost } from "../ingest/poster";
import type { Summarize } from "../ingest/summarizer";
import { formatSchedule, parseSchedule } from "../pipeline/schedule-text";
import * as cards from "../repositories/cards";
import * as people from "../repositories/people";
import * as photos from "../repositories/photos";
import * as sessions from "../repositories/sessions";
import * as stages from "../repositories/stages";
import * as talks from "../repositories/talks";

export interface AdminDeps {
  db: Queryable;
  summarize?: Summarize;
  post?: WritePost;
}

/** Answers 400 with the first issue and returns null when the body does not parse. */
function body<T>(schema: z.ZodType<T>, raw: unknown, res: Response): T | null {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  res.status(400).json({ error: `${issue?.path.join(".") || "body"}: ${issue?.message}` });
  return null;
}

const ConferenceBody = z.object({ conference: z.string().trim().min(1).max(200) });

const notFound = (res: Response, what: string): void => void res.status(404).json({ error: `${what} not found` });

/** The admin area's writes: stages, their schedules, people, and asking for a summary or a post again. */
export function adminRouter({ db, summarize, post }: AdminDeps): Router {
  const router = Router();

  const stageWithTalks = async (id: string): Promise<StageWithTalks | null> => {
    const stage = await stages.get(db, id);
    return stage ? { stage, talks: await talks.forStage(db, id), videos: await sessions.forStage(db, id) } : null;
  };

  router.get("/stages", async (_req, res, next) => {
    try {
      const all = await stages.list(db);
      res.json(await Promise.all(all.map((stage) => stageWithTalks(stage.id))));
    } catch (error) {
      next(error);
    }
  });

  router.post("/stages", async (req, res, next) => {
    try {
      const input = body(StageBody, req.body, res);
      if (input) res.status(201).json(await stages.create(db, input));
    } catch (error) {
      next(error);
    }
  });

  router.get("/stages/:id", async (req, res, next) => {
    try {
      const found = await stageWithTalks(req.params.id);
      if (!found) return notFound(res, "stage");
      res.json({ ...found, text: formatSchedule(found.talks) });
    } catch (error) {
      next(error);
    }
  });

  router.put("/stages/:id", async (req, res, next) => {
    try {
      const input = body(StageBody, req.body, res);
      if (!input) return;
      const stage = await stages.update(db, req.params.id, input);
      if (!stage) return notFound(res, "stage");
      res.json(stage);
    } catch (error) {
      next(error);
    }
  });

  router.post("/stages/:id/talks", async (req, res, next) => {
    try {
      const input = body(TalkBody, req.body, res);
      if (!input) return;
      const stage = await stages.get(db, req.params.id);
      if (!stage) return notFound(res, "stage");
      res.status(201).json(await talks.create(db, stage.id, input));
    } catch (error) {
      next(error);
    }
  });

  // A pasted schedule is appended. All of it or none: one unreadable line refuses the paste and names the line.
  router.post("/stages/:id/import", async (req, res, next) => {
    try {
      const input = body(ImportBody, req.body, res);
      if (!input) return;
      const stage = await stages.get(db, req.params.id);
      if (!stage) return notFound(res, "stage");
      const parsed = parseSchedule(input.text);
      if (parsed.errors.length > 0 || parsed.talks.length === 0) {
        res.status(400).json({ error: parsed.errors.join("; ") || "no talks in the text" });
        return;
      }
      const created = [];
      for (const talk of parsed.talks) created.push(await talks.create(db, stage.id, talk));
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  router.put("/talks/:id", async (req, res, next) => {
    try {
      const input = body(TalkBody, req.body, res);
      if (!input) return;
      const talk = await talks.update(db, Number(req.params.id) || 0, input);
      if (!talk) return notFound(res, "talk");
      res.json(talk);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/talks/:id", async (req, res, next) => {
    try {
      if (!(await talks.archive(db, Number(req.params.id) || 0))) return notFound(res, "talk");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // Writes the talk's summary again from the video it was heard in. Answers once it is written, which takes the model a while.
  router.post("/talks/:id/summary", async (req, res, next) => {
    try {
      const [card] = await cards.talkCards(db, { id: Number(req.params.id) || 0 });
      if (!card) return notFound(res, "talk");
      if (!card.session_id || !summarize) {
        res.status(409).json({ error: "this talk has not been heard in a video yet" });
        return;
      }
      const summary = await summarize(card.session_id, card.talk.id, { force: true });
      if (!summary) {
        res.status(502).json({ error: "the summary could not be written; the model call is stored with the reason" });
        return;
      }
      res.status(201).json(summary);
    } catch (error) {
      next(error);
    }
  });

  // Writes the talk's X post again from its summary and claims in the video it was heard in. Answers once it is written.
  router.post("/talks/:id/post", async (req, res, next) => {
    try {
      const [card] = await cards.talkCards(db, { id: Number(req.params.id) || 0 });
      if (!card) return notFound(res, "talk");
      if (!card.session_id || !post) {
        res.status(409).json({ error: "this talk has not been heard in a video yet" });
        return;
      }
      const written = await post(card.session_id, card.talk.id, { force: true });
      if (!written) {
        res.status(502).json({ error: "the post could not be written: the talk has no summary yet, or the model call is stored with the reason" });
        return;
      }
      res.status(201).json(written);
    } catch (error) {
      next(error);
    }
  });

  router.post("/people", async (req, res, next) => {
    try {
      const input = body(PersonBody, req.body, res);
      if (input) res.status(201).json(await people.upsertByName(db, input));
    } catch (error) {
      next(error);
    }
  });

  router.put("/people/:id", async (req, res, next) => {
    try {
      const input = body(PersonBody, req.body, res);
      if (!input) return;
      const person = await people.update(db, Number(req.params.id) || 0, input);
      if (!person) return notFound(res, "person");
      res.json(person);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/people/:id", async (req, res, next) => {
    try {
      if (!(await people.remove(db, Number(req.params.id) || 0))) return notFound(res, "person");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // A conference a person is listed for without a tracked session there: the official speaker list, for instance.
  router.post("/people/:id/conferences", async (req, res, next) => {
    try {
      const input = body(ConferenceBody, req.body, res);
      if (!input) return;
      if (!(await people.addConference(db, Number(req.params.id) || 0, input.conference))) return notFound(res, "person");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/people/:id/conferences/:conference", async (req, res, next) => {
    try {
      if (!(await people.removeConference(db, Number(req.params.id) || 0, req.params.conference))) return notFound(res, "listing");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.put("/people/:id/photo", async (req, res, next) => {
    try {
      const input = body(PhotoBody, req.body, res);
      if (!input) return;
      const person = await photos.put(db, Number(req.params.id) || 0, { content_type: input.content_type, bytes: Buffer.from(input.data, "base64") });
      if (!person) return notFound(res, "person");
      res.json(person);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
