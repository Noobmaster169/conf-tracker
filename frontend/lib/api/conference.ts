import { z } from "zod";

/**
 * The conference layer, mirrored by hand from backend/src/contracts-conference.ts. Change both or neither.
 * A "talk" is one scheduled conference session; the pages call it a session.
 */
export const Person = z.object({ id: z.number(), name: z.string(), org: z.string().nullable(), title: z.string().nullable(), photo_url: z.string().nullable(), x_url: z.string().nullish() });
export type Person = z.infer<typeof Person>;

export const Stage = z.object({ id: z.string(), conference: z.string(), name: z.string(), day: z.string().nullable(), description: z.string(), hidden: z.boolean().default(false), created_at: z.string() });
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

export const Span = z.object({
  id: z.number(),
  session_id: z.string(),
  talk_id: z.number().nullable(),
  state: z.enum(["talk", "break"]),
  t0: z.number(),
  t1: z.number().nullable(),
  confidence: z.number().nullable(),
  source: z.enum(["tracker", "admin"]),
});
export type Span = z.infer<typeof Span>;

// A markdown article, and its headline lifted out for the lists.
export const SummaryBody = z.object({ headline: z.string(), content: z.string() });
export type SummaryBody = z.infer<typeof SummaryBody>;

export const TalkSummary = z.object({ id: z.number(), talk_id: z.number(), session_id: z.string(), summary: SummaryBody, created_at: z.string() });
export type TalkSummary = z.infer<typeof TalkSummary>;

// A talk's highlight post for X, footer included.
export const TalkPost = z.object({ id: z.number(), talk_id: z.number(), session_id: z.string(), text: z.string(), created_at: z.string() });
export type TalkPost = z.infer<typeof TalkPost>;
