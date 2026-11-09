import { Router } from "express";

import { ClaimSearchQuery } from "../contracts";
import type { Queryable } from "../db";
import { search } from "../repositories/claim-search";

const REPEATABLE = ["topic", "speaker", "polarity", "session"] as const;

const many = (value: unknown): string[] => (value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)]);

/** GET /claims: every claim across sessions, filtered by the query string, with facets over the same set. */
export function claimSearchRouter({ db }: { db: Queryable }): Router {
  const router = Router();
  router.get("/", async (req, res, next) => {
    try {
      const raw: Record<string, unknown> = { ...req.query };
      for (const key of REPEATABLE) raw[key] = many(req.query[key]);
      const query = ClaimSearchQuery.safeParse(raw);
      if (!query.success) {
        const issue = query.error.issues[0];
        res.status(400).json({ error: `${String(issue?.path[0] ?? "query")}: ${issue?.message}` });
        return;
      }
      res.json(await search(db, query.data));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
