import { z } from "zod";

/** The framer's settings, stored under the `frames` key; each grab reads them again, so a change applies at the next. */
export const FrameSettings = z.object({
  enabled: z.boolean().default(true),
  // Seconds between grabs of a live video, and between keyframes taken from a recording.
  interval_s: z.number().min(3).max(300).default(10),
  coarse_delta: z.number().min(1).max(255).default(12),
  coarse_frac: z.number().min(0).max(1).default(0.4),
  fine_delta: z.number().min(1).max(255).default(6),
  fine_frac: z.number().min(0).max(1).default(0.07),
  settle_frac: z.number().min(0).max(1).default(0.5),
  // Width of the stored image and of its thumbnail, in pixels.
  width: z.number().int().min(320).max(1920).default(1280),
  thumb_width: z.number().int().min(160).max(960).default(480),
  quality: z.number().int().min(30).max(100).default(78),
});
export type FrameSettings = z.infer<typeof FrameSettings>;

export const Frame = z.object({
  id: z.number(),
  session_id: z.string(),
  t: z.number(),
  talk_id: z.number().nullable(),
  url: z.string(),
  thumb_url: z.string(),
  width: z.number(),
  height: z.number(),
  hidden: z.boolean(),
  blocked: z.boolean(),
  created_at: z.string(),
});
export type Frame = z.infer<typeof Frame>;

export const FramePatch = z.object({ hidden: z.boolean().optional(), block: z.boolean().optional() }).strict();
export type FramePatch = z.infer<typeof FramePatch>;
