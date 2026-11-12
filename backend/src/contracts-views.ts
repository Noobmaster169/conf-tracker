import { z } from "zod";

import { Claim, ClaimKind, Gap, Person, Session, Stage, Talk, TalkSummary } from "./contracts";

/** What the app's pages read: claims with who and where resolved, and cards for videos, talks and people. Mirrored in the frontend's lib/api/conference.ts. */

// A claim as a reader meets it: the person who said it, the talk it was said in and the video it came from.
export const FeedItem = Claim.extend({
  speaker_name: z.string().nullable(),
  person: Person.nullable(),
  talk: z.object({ id: z.number(), title: z.string() }).nullable(),
  video: z.object({ session_id: z.string(), video_id: z.string().nullable(), title: z.string().nullable(), started_at: z.string().nullable() }),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const Feed = z.object({ items: z.array(FeedItem), next_before: z.number().nullable() });
export type Feed = z.infer<typeof Feed>;

export const FeedQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  kind: ClaimKind.optional(),
  min_importance: z.coerce.number().int().min(1).max(5).optional(),
  person: z.coerce.number().int().positive().optional(),
  talk: z.coerce.number().int().positive().optional(),
  session: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type FeedQuery = z.output<typeof FeedQuery>;

export const VideoCard = z.object({
  session: Session,
  stage: Stage.nullable(),
  now: z.object({ id: z.number(), title: z.string() }).nullable(),
  claim_count: z.number(),
  duration_s: z.number(),
  // Stretches of the stream no leg covered and nothing has filled yet.
  gaps: z.array(Gap),
  // How far behind the stream a running video's last stored health said it was; null when stopped or unknown.
  behind_s: z.number().nullable(),
});
export type VideoCard = z.infer<typeof VideoCard>;

export const TalkStatus = z.enum(["upcoming", "live", "ended"]);
export type TalkStatus = z.infer<typeof TalkStatus>;

export const TalkCard = z.object({
  talk: Talk,
  stage: Stage,
  status: TalkStatus,
  // The video the talk was heard in, once the tracker has placed it.
  session_id: z.string().nullable(),
  video_id: z.string().nullable(),
  t0: z.number().nullable(),
  t1: z.number().nullable(),
  claim_count: z.number(),
  headline: z.string().nullable(),
});
export type TalkCard = z.infer<typeof TalkCard>;

export const TalkDetail = TalkCard.extend({ summary: TalkSummary.nullable(), claims: z.array(FeedItem) });
export type TalkDetail = z.infer<typeof TalkDetail>;

/** `conferences`: every conference the person belongs to, from a visible schedule, a video they were heard in, or a listing. */
export const PersonCard = z.object({ person: Person, claim_count: z.number(), talk_count: z.number(), last_seen: z.string().nullable(), conferences: z.array(z.string()) });
export type PersonCard = z.infer<typeof PersonCard>;

export const PersonDetail = PersonCard.extend({ talks: z.array(TalkCard), claims: z.array(FeedItem) });
export type PersonDetail = z.infer<typeof PersonDetail>;

export const StageWithTalks = z.object({ stage: Stage, talks: z.array(Talk), videos: z.array(Session) });
export type StageWithTalks = z.infer<typeof StageWithTalks>;
