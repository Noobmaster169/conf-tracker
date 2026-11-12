import { z } from "zod";

/**
 * The conference layer's shapes: stages, the schedule (talks), people, the on-stage timeline and summaries.
 * Re-exported by contracts.ts; imports nothing from it. The frontend mirrors this in lib/api/conference.ts.
 *
 * A "talk" is one scheduled conference session. The word session is taken by an ingestion of a video.
 */

export const Person = z.object({
  id: z.number(),
  name: z.string(),
  org: z.string().nullable(),
  title: z.string().nullable(),
  photo_url: z.string().nullable(),
});
export type Person = z.infer<typeof Person>;

export const Stage = z.object({
  id: z.string(),
  conference: z.string(),
  name: z.string(),
  day: z.string().nullable(),
  description: z.string(),
  // A test run's stage: kept, and shown only in the admin area.
  hidden: z.boolean(),
  created_at: z.string(),
});
export type Stage = z.infer<typeof Stage>;

export const TalkKind = z.enum(["talk", "panel", "fireside", "keynote", "break", "other"]);
export type TalkKind = z.infer<typeof TalkKind>;

export const TalkRole = z.enum(["speaker", "moderator", "host"]);
export type TalkRole = z.infer<typeof TalkRole>;

export const TalkSpeaker = Person.extend({ role: TalkRole });
export type TalkSpeaker = z.infer<typeof TalkSpeaker>;

export const Talk = z.object({
  id: z.number(),
  stage_id: z.string(),
  title: z.string(),
  description: z.string(),
  kind: TalkKind,
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  position: z.number(),
  speakers: z.array(TalkSpeaker),
});
export type Talk = z.infer<typeof Talk>;

export const SpanState = z.enum(["talk", "break"]);
export type SpanState = z.infer<typeof SpanState>;

// One stretch of a video with one thing on stage. t1 null is the stretch still running.
export const Span = z.object({
  id: z.number(),
  session_id: z.string(),
  talk_id: z.number().nullable(),
  state: SpanState,
  t0: z.number(),
  t1: z.number().nullable(),
  confidence: z.number().nullable(),
  source: z.enum(["tracker", "admin"]),
});
export type Span = z.infer<typeof Span>;

// The briefing written about a finished talk: a markdown article, and its headline lifted out for the lists.
export const SummaryBody = z.object({ headline: z.string().min(1), content: z.string().min(1) });
export type SummaryBody = z.infer<typeof SummaryBody>;

export const TalkSummary = z.object({ id: z.number(), talk_id: z.number(), session_id: z.string(), summary: SummaryBody, created_at: z.string() });
export type TalkSummary = z.infer<typeof TalkSummary>;

// Tracker settings, read out of session.config like ExtractConfig. Unknown keys are ignored.
export const TrackConfig = z.object({
  track: z.boolean().default(true),
  track_interval_s: z.number().min(5).default(60),
  track_window_s: z.number().positive().default(240),
  // One read at or above this, with its quote found in the transcript, switches at once; a weaker one needs a second read to agree.
  track_switch_confidence: z.number().min(0).max(1).default(0.8),
  track_model: z.string().min(1).default("sonnet"),
  track_prompt: z.string().regex(/^v\d+$/).default("v1"),
});
export type TrackConfig = z.infer<typeof TrackConfig>;

export const SummaryConfig = z.object({
  summarize: z.boolean().default(true),
  // A span shorter than this is a false start or a hand-off, not a talk worth a summary.
  summary_min_s: z.number().nonnegative().default(180),
  // One call per talk, and the writing is the product, so it gets the strongest tier (as yt-engine summarises).
  summary_model: z.string().min(1).default("opus"),
  summary_prompt: z.string().regex(/^v\d+$/).default("v1"),
});
export type SummaryConfig = z.infer<typeof SummaryConfig>;

// The Poster's settings, in session.config like the summarizer's. It writes once a talk's summary is written.
export const PostConfig = z.object({
  post: z.boolean().default(true),
  post_model: z.string().min(1).default("opus"),
  post_prompt: z.string().regex(/^v\d+$/).default("v2"),
  // Added under every post, after a blank line, by the code and not the model, so it is always exactly this.
  post_footer: z.string().max(500).default("Real-time Breakpoint Alpha streamed at: https://breakpoint.fiber.ag"),
});
export type PostConfig = z.infer<typeof PostConfig>;

// A talk's highlight post for X, footer included: what the session page shows and the X button sends.
export const TalkPost = z.object({ id: z.number(), talk_id: z.number(), session_id: z.string(), text: z.string(), created_at: z.string() });
export type TalkPost = z.infer<typeof TalkPost>;

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullish().transform((v) => v || null);

export const StageBody = z.object({
  conference: text(200).min(1),
  name: text(200).min(1),
  day: z.iso.date().nullish().transform((v) => v ?? null),
  description: text(4000).default(""),
  hidden: z.boolean().default(false),
});
export type StageBody = z.infer<typeof StageBody>;

// A photo is a link the admin found, or the path of one stored here (PUT /people/:id/photo).
const photoUrl = z.union([z.url().max(2000), z.string().regex(/^\/people\/\d+\/photo(\?v=\d+)?$/)]);
export const PersonBody = z.object({ name: text(200).min(1), org: optionalText(200), title: optionalText(200), photo_url: photoUrl.nullish().transform((v) => v ?? null) });
export type PersonBody = z.infer<typeof PersonBody>;

// PUT /people/:id/photo: the image itself, base64, so it travels as JSON like every other body. About 700 KB at most.
export const PhotoBody = z.object({ content_type: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.base64().min(1).max(950_000) });
export type PhotoBody = z.infer<typeof PhotoBody>;

export const TalkSpeakerBody = z.object({ name: text(200).min(1), org: optionalText(200), title: optionalText(200), role: TalkRole.default("speaker") });
export type TalkSpeakerBody = z.infer<typeof TalkSpeakerBody>;

const clock = z.string().regex(/^\d{1,2}:\d{2}$/).nullish().transform((v) => v ?? null);

export const TalkBody = z.object({
  title: text(300).min(1),
  description: text(4000).default(""),
  kind: TalkKind.default("talk"),
  starts_at: clock,
  ends_at: clock,
  speakers: z.array(TalkSpeakerBody).max(30).default([]),
});
export type TalkBody = z.infer<typeof TalkBody>;

// POST /stages/:id/import: the pasted schedule, one talk per line (lib/schedule-text.ts).
export const ImportBody = z.object({ text: z.string().min(1).max(100_000) });

// POST /sessions/:id/now: the admin says what is on stage from here on. A null talk is a break.
export const NowBody = z.object({ talk_id: z.number().int().positive().nullable(), t: z.number().nonnegative().optional() });
export type NowBody = z.infer<typeof NowBody>;
