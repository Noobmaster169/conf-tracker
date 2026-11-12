import { z } from "zod";

import { Person, Stage, Talk, TalkPost, TalkSummary } from "./conference";
import { Claim, Gap, Session } from "./schemas";

/** What the pages read, mirrored by hand from backend/src/contracts-views.ts. Change both or neither. */
export const FeedItem = Claim.extend({
  speaker_name: z.string().nullable(),
  person: Person.nullable(),
  talk: z.object({ id: z.number(), title: z.string() }).nullable(),
  video: z.object({ session_id: z.string(), video_id: z.string().nullable(), title: z.string().nullable(), started_at: z.string().nullable() }),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const Feed = z.object({ items: z.array(FeedItem), next_before: z.number().nullable() });
export type Feed = z.infer<typeof Feed>;

export const VideoCard = z.object({
  session: Session,
  stage: Stage.nullable(),
  now: z.object({ id: z.number(), title: z.string() }).nullable(),
  claim_count: z.number(),
  duration_s: z.number(),
  gaps: z.array(Gap).default([]),
  // How far behind the stream a running video's last stored health said it was; an older api omits it.
  behind_s: z.number().nullable().default(null),
});
export type VideoCard = z.infer<typeof VideoCard>;

export const TalkStatus = z.enum(["upcoming", "live", "ended"]);
export type TalkStatus = z.infer<typeof TalkStatus>;

export const TalkCard = z.object({
  talk: Talk,
  stage: Stage,
  status: TalkStatus,
  session_id: z.string().nullable(),
  video_id: z.string().nullable(),
  t0: z.number().nullable(),
  t1: z.number().nullable(),
  claim_count: z.number(),
  headline: z.string().nullable(),
});
export type TalkCard = z.infer<typeof TalkCard>;

// `post` defaults to null: the dashboard ships before the api while a video holds the api's deploy back.
export const TalkDetail = TalkCard.extend({ summary: TalkSummary.nullable(), post: TalkPost.nullable().default(null), claims: z.array(FeedItem) });
export type TalkDetail = z.infer<typeof TalkDetail>;

// conferences: from a visible schedule, a video the person was heard in, or a listing. Defaults so an older api still parses.
export const PersonCard = z.object({ person: Person, claim_count: z.number(), talk_count: z.number(), last_seen: z.string().nullable(), conferences: z.array(z.string()).default([]) });
export type PersonCard = z.infer<typeof PersonCard>;

export const PersonDetail = PersonCard.extend({ talks: z.array(TalkCard), claims: z.array(FeedItem) });
export type PersonDetail = z.infer<typeof PersonDetail>;

export const StageWithTalks = z.object({ stage: Stage, talks: z.array(Talk), videos: z.array(Session) });
export type StageWithTalks = z.infer<typeof StageWithTalks>;

export const StageDetail = StageWithTalks.extend({ text: z.string() });
export type StageDetail = z.infer<typeof StageDetail>;
