import { z } from "zod";

import { Person, Span, Stage, Talk } from "./conference";

/** Mirrored by hand from backend/src/contracts.ts. Change both or neither. */
export const Word = z.object({ w: z.string(), t0: z.number(), t1: z.number(), p: z.number(), speaker_id: z.string().nullable() });
export type Word = z.infer<typeof Word>;

export const SessionStatus = z.enum(["starting", "live", "recovering", "degraded", "stopped"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: z.string(),
  source_url: z.string().nullable(),
  source_file: z.string().nullable(),
  // Older backends omit it; every session before phase 5 is an original.
  replay_of: z.string().nullable().default(null),
  video_id: z.string().nullable(),
  status: SessionStatus,
  started_at: z.string().nullable(),
  stopped_at: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  models: z.record(z.string(), z.string()),
  error: z.string().nullable(),
  created_at: z.string(),
  // Older backends omit both: a video with no stage and no stored title.
  stage_id: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  // Older backends omit both: nothing needs attention and nothing is recovering.
  attention: z.string().nullable().default(null),
  recovering_since: z.string().nullable().default(null),
});
export type Session = z.infer<typeof Session>;

export const Segment = z.object({ id: z.number(), session_id: z.string(), t0: z.number(), t1: z.number(), text: z.string(), words: z.array(Word) });
export type Segment = z.infer<typeof Segment>;

export const Gap = z.object({
  id: z.number(),
  session_id: z.string(),
  t0: z.number(),
  t1: z.number(),
  filled_at: z.string().nullable(),
  created_at: z.string(),
  // Why the recording could not fill it, once filling was given up.
  note: z.string().nullable().default(null),
  stage: z.enum(["transcribed", "tracked", "named", "extracted", "summarised"]).nullable().default(null),
  stage_at: z.string().nullable().default(null),
  tried_at: z.string().nullable().default(null),
  since: z.string().nullable().default(null),
});
export type Gap = z.infer<typeof Gap>;

export const Health = z.object({
  t: z.number(),
  lag_s: z.number(),
  gpu_ms_asr: z.number(),
  gpu_ms_diar: z.number(),
  buffer_s: z.number(),
  // Seconds behind the live edge while catching up; null (or absent on an older backend) when not live.
  behind_s: z.number().nullable().default(null),
  received_at: z.string(),
});
export type Health = z.infer<typeof Health>;

export const Turn = z.object({ t0: z.number(), t1: z.number(), speaker_id: z.string() });
export type Turn = z.infer<typeof Turn>;

export const DiarWindow = z.object({ t0: z.number(), t1: z.number() });
export type DiarWindow = z.infer<typeof DiarWindow>;

// The name fields default: the frontend deploys on Vercel before the box's api rolls forward, and an older speaker row has none.
export const Speaker = z.object({
  speaker_id: z.string(),
  first_seen_t: z.number(),
  last_seen_t: z.number(),
  talk_s: z.number(),
  merged_into: z.string().nullable(),
  name: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  name_confidence: z.number().nullable().default(null),
  name_quote: z.string().nullable().default(null),
  name_call_id: z.number().nullable().default(null),
  person_id: z.number().nullable().default(null),
});
export type Speaker = z.infer<typeof Speaker>;

export const TurnsUpdate = z.object({ window: DiarWindow, turns: z.array(Turn) });
export type TurnsUpdate = z.infer<typeof TurnsUpdate>;

export const Polarity = z.enum(["bullish", "bearish", "neutral", "none"]);
export type Polarity = z.infer<typeof Polarity>;

export const ClaimStatus = z.enum(["ok", "unverified", "duplicate"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const ClaimKind = z.enum(["announcement", "metric", "roadmap", "opinion", "fact"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const Claim = z.object({
  id: z.number(),
  session_id: z.string(),
  call_id: z.number(),
  speaker_id: z.string().nullable(),
  t0: z.number().nullable(),
  t1: z.number().nullable(),
  claim: z.string(),
  topics: z.array(z.string()),
  polarity: Polarity,
  quote: z.string(),
  quote_verified: z.boolean(),
  status: ClaimStatus,
  kind: ClaimKind.nullable().default(null),
  importance: z.number().nullable().default(null),
  created_at: z.string(),
});
export type Claim = z.infer<typeof Claim>;

// What the feed and the SSE ring carry about a call; the texts stay behind GET /calls/:id.
export const CallSummary = z.object({
  id: z.number(),
  session_id: z.string(),
  step: z.string(),
  prompt_version: z.string(),
  model: z.string(),
  window_t0: z.number(),
  window_t1: z.number(),
  attempt: z.number(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cost_usd: z.number().nullable(),
  latency_ms: z.number(),
  error: z.string().nullable(),
  claim_count: z.number(),
  created_at: z.string(),
});
export type CallSummary = z.infer<typeof CallSummary>;

export const Snapshot = z.object({
  session: Session,
  segments: z.array(Segment),
  health: Health.nullable(),
  speakers: z.array(Speaker),
  // A deliberate read-side difference from the backend: the frontend deploys on Vercel before the box's api rolls forward, and a page must still parse the older snapshot in that window.
  claims: z.array(Claim).default([]),
  calls: z.array(CallSummary).default([]),
  cost_usd: z.number().default(0),
  gaps: z.array(Gap).default([]),
  seq: z.number(),
  stage: Stage.nullable().default(null),
  talks: z.array(Talk).default([]),
  spans: z.array(Span).default([]),
  people: z.array(Person).default([]),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ seq: z.number(), type: z.literal("snapshot"), data: Snapshot }),
  z.object({ seq: z.number(), type: z.literal("segment"), data: Segment }),
  z.object({ seq: z.number(), type: z.literal("health"), data: Health }),
  z.object({ seq: z.number(), type: z.literal("session"), data: Session }),
  z.object({ seq: z.number(), type: z.literal("segment.updated"), data: Segment }),
  z.object({ seq: z.number(), type: z.literal("turns"), data: TurnsUpdate }),
  z.object({ seq: z.number(), type: z.literal("speaker"), data: Speaker }),
  z.object({ seq: z.number(), type: z.literal("call"), data: CallSummary }),
  z.object({ seq: z.number(), type: z.literal("claims.new"), data: z.array(Claim) }),
  z.object({ seq: z.number(), type: z.literal("span"), data: Span }),
  z.object({ seq: z.number(), type: z.literal("person"), data: Person }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;
