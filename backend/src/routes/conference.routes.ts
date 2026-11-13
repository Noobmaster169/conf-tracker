import { Router } from "express";

import { FeedQuery, type PersonDetail, type TalkDetail } from "../contracts-views";
import type { Queryable } from "../db";
import * as cards from "../repositories/cards";
import * as feed from "../repositories/feed";
import * as photos from "../repositories/photos";
import * as posts from "../repositories/posts";
import * as summaries from "../repositories/summaries";

// A person's or a talk's page shows its claims in one go; more than this is paged through GET /feed.
const PAGE_CLAIMS = 200;

/** What the app's pages read: the video cards, the claims feed, people and the schedule with its summaries. Read-only. */
export function conferenceRouter({ db, frameUrl = null }: { db: Queryable; frameUrl?: ((key: string) => string) | null }): Router {
  const router = Router();

  // ?all=1 is the admin area's list: it includes the videos of hidden stages.
  router.get("/videos", async (req, res, next) => {
    try {
      res.json(await cards.videos(db, req.query.all === "1", frameUrl));
    } catch (error) {
      next(error);
    }
  });

  router.get("/feed", async (req, res, next) => {
    try {
      const query = FeedQuery.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: `${query.error.issues[0]?.path.join(".")}: ${query.error.issues[0]?.message}` });
        return;
      }
      res.json(await feed.list(db, query.data));
    } catch (error) {
      next(error);
    }
  });

  router.get("/people", async (req, res, next) => {
    try {
      res.json(await cards.peopleCards(db, undefined, req.query.all === "1"));
    } catch (error) {
      next(error);
    }
  });

  router.get("/people/:id/photo", async (req, res, next) => {
    try {
      const photo = await photos.get(db, Number(req.params.id) || 0);
      if (!photo) {
        res.status(404).json({ error: "photo not found" });
        return;
      }
      // The path carries a version that changes with every upload, so this answer never goes stale.
      res.set("cache-control", "private, max-age=31536000, immutable").type(photo.content_type).send(photo.bytes);
    } catch (error) {
      next(error);
    }
  });

  router.get("/people/:id", async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const [card] = Number.isInteger(id) && id > 0 ? await cards.peopleCards(db, id) : [];
      if (!card) {
        res.status(404).json({ error: "person not found" });
        return;
      }
      const claims = await feed.list(db, FeedQuery.parse({ person: id, limit: PAGE_CLAIMS }));
      const detail: PersonDetail = { ...card, talks: await cards.talkCards(db, { personId: id }), claims: claims.items };
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.get("/talks", async (_req, res, next) => {
    try {
      res.json(await cards.talkCards(db));
    } catch (error) {
      next(error);
    }
  });

  router.get("/talks/:id", async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const [card] = Number.isInteger(id) && id > 0 ? await cards.talkCards(db, { id }) : [];
      if (!card) {
        res.status(404).json({ error: "talk not found" });
        return;
      }
      const claims = await feed.list(db, FeedQuery.parse({ talk: id, limit: PAGE_CLAIMS }));
      // Oldest first: a talk's claims read in the order they were said.
      const detail: TalkDetail = { ...card, summary: await summaries.latest(db, id), post: await posts.latest(db, id), claims: claims.items.reverse() };
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
