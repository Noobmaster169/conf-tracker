import { Router } from "express";
import { z } from "zod";

import { FramePatch, FrameSettings } from "../contracts-frames";
import type { Queryable } from "../db";
import { frameSettings, SETTINGS_KEY, type Framer } from "../frames/framer";
import * as frames from "../repositories/frames";
import * as settings from "../repositories/settings";

export interface FramesDeps {
  db: Queryable;
  framer?: Framer | null;
  /** The public URL of a stored key; null when no store is configured. */
  frameUrl?: ((key: string) => string) | null;
}

const SettingsPatch = z.object({ set: z.record(z.string(), z.unknown()) }).strict();
const FillBody = z.object({ from: z.number().min(0).optional() }).strict();
const id = (raw: unknown): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The galleries, a frame's hide and block, and the framer's settings and state. */
export function framesRouter({ db, framer = null, frameUrl = null }: FramesDeps): Router {
  const router = Router();
  const url = frameUrl ?? ((key: string) => key);

  router.get("/sessions/:id/frames", async (req, res, next) => {
    try {
      res.json(await frames.forSession(db, req.params.id, url, { all: req.query.all === "1" }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/talks/:id/frames", async (req, res, next) => {
    try {
      const talkId = id(req.params.id);
      if (talkId === null) {
        res.status(404).json({ error: "talk not found" });
        return;
      }
      res.json(await frames.forTalk(db, talkId, url));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/frames/:id", async (req, res, next) => {
    try {
      const frameId = id(req.params.id);
      const body = FramePatch.safeParse(req.body);
      if (frameId === null || !body.success) {
        res.status(400).json({ error: body.success ? "bad id" : body.error.message });
        return;
      }
      const frame = await frames.patch(db, frameId, body.data, url);
      if (!frame) {
        res.status(404).json({ error: "frame not found" });
        return;
      }
      framer?.invalidate();
      res.json(frame);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:id/frames/fill", async (req, res, next) => {
    try {
      if (!framer) {
        res.status(503).json({ error: "frames are off: R2 is not configured on this api" });
        return;
      }
      const body = FillBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: body.error.message });
        return;
      }
      try {
        await framer.startFill(req.params.id, body.data);
      } catch (error) {
        res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      res.status(202).json({ started: true, note: "the whole recording is read in the background; GET /ops/frames shows its progress" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/ops/frames", async (_req, res, next) => {
    try {
      const stored = (await settings.get<Record<string, unknown>>(db, SETTINGS_KEY))?.value ?? {};
      res.json({
        configured: framer !== null,
        settings: await frameSettings(db),
        stored,
        defaults: FrameSettings.parse({}),
        state: framer ? await framer.status() : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/ops/frames", async (req, res, next) => {
    try {
      const body = SettingsPatch.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.message });
        return;
      }
      const stored = (await settings.get<Record<string, unknown>>(db, SETTINGS_KEY))?.value ?? {};
      const next_ = { ...stored };
      // A null takes a key back to its default.
      for (const [k, v] of Object.entries(body.data.set)) {
        if (v === null) delete next_[k];
        else next_[k] = v;
      }
      const parsed = FrameSettings.strict().safeParse(next_);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      await settings.put(db, SETTINGS_KEY, next_);
      res.json({ settings: parsed.data, stored: next_, note: "applies at the next grab" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
