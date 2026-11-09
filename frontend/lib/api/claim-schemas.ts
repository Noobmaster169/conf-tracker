import { z } from "zod";

import { Claim, Speaker } from "./schemas";

/** GET /claims, mirrored by hand from backend/src/contracts.ts. Change both or neither. */
export const Lean = z.object({ bullish: z.number(), bearish: z.number(), neutral: z.number(), none: z.number() });
export type Lean = z.infer<typeof Lean>;

export const ClaimHit = Claim.extend({ speaker: z.object({ id: z.string().nullable(), name: z.string().nullable(), role: z.string().nullable() }) });
export type ClaimHit = z.infer<typeof ClaimHit>;

export const ShowFacet = z.object({
  session_id: z.string(),
  video_id: z.string().nullable(),
  source_file: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  count: z.number(),
});
export type ShowFacet = z.infer<typeof ShowFacet>;

export const TopicFacet = z.object({ value: z.string(), count: z.number(), lean: Lean, voices: z.array(z.string()) });
export type TopicFacet = z.infer<typeof TopicFacet>;

export const SpeakerFacet = z.object({ name: z.string().nullable(), count: z.number(), lean: Lean, topics: z.array(z.string()) });
export type SpeakerFacet = z.infer<typeof SpeakerFacet>;

export const ClaimSearch = z.object({
  total: z.number(),
  as_of: z.number().nullable(),
  offset: z.number(),
  next_offset: z.number().nullable(),
  items: z.array(ClaimHit),
  lean: Lean,
  shows: z.array(ShowFacet),
  topics: z.array(TopicFacet),
  speakers: z.array(SpeakerFacet),
  session_speakers: z.record(z.string(), z.array(Speaker)),
});
export type ClaimSearch = z.infer<typeof ClaimSearch>;
