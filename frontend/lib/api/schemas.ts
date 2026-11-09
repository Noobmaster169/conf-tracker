import { z } from "zod";

/** Mirrored by hand from backend/src/contracts.ts. Change both or neither. */
export const Word = z.object({ w: z.string(), t0: z.number(), t1: z.number(), p: z.number(), speaker_id: z.string().nullable() });
export type Word = z.infer<typeof Word>;

export const SessionStatus = z.enum(["starting", "live", "degraded", "stopped"]);
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
});
export type Session = z.infer<typeof Session>;

export const Segment = z.object({ id: z.number(), session_id: z.string(), t0: z.number(), t1: z.number(), text: z.string(), words: z.array(Word) });
export type Segment = z.infer<typeof Segment>;

export const Health = z.object({
  t: z.number(),
  lag_s: z.number(),
  gpu_ms_asr: z.number(),
  gpu_ms_diar: z.number(),
  buffer_s: z.number(),
  received_at: z.string(),
});
export type Health = z.infer<typeof Health>;

export const Turn = z.object({ t0: z.number(), t1: z.number(), speaker_id: z.string() });
export type Turn = z.infer<typeof Turn>;

// One local pyannote speaker of a window and how it resolved against the registry.
export const Match = z.object({
  local: z.string(),
  speech_s: z.number(),
  speaker_id: z.string().nullable(),
  scores: z.record(z.string(), z.number()),
  new: z.boolean(),
});
export type Match = z.infer<typeof Match>;

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
});
export type Speaker = z.infer<typeof Speaker>;

export const ProposalStatus = z.enum(["accepted", "rejected"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const NameProposal = z.object({
  id: z.number(),
  session_id: z.string(),
  call_id: z.number(),
  speaker_id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  confidence: z.number(),
  quote: z.string(),
  quote_verified: z.boolean(),
  status: ProposalStatus,
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type NameProposal = z.infer<typeof NameProposal>;

export const WindowRecord = z.object({ id: z.number(), t0: z.number(), t1: z.number(), gpu_ms: z.number(), matches: z.array(Match) });
export type WindowRecord = z.infer<typeof WindowRecord>;

export const SpeakerDetail = z.object({ speaker: Speaker, windows: z.array(WindowRecord), proposals: z.array(NameProposal).default([]) });
export type SpeakerDetail = z.infer<typeof SpeakerDetail>;

export const TurnsUpdate = z.object({ window: DiarWindow, turns: z.array(Turn) });
export type TurnsUpdate = z.infer<typeof TurnsUpdate>;

export const Polarity = z.enum(["bullish", "bearish", "neutral", "none"]);
export type Polarity = z.infer<typeof Polarity>;

export const ClaimStatus = z.enum(["ok", "unverified", "duplicate"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

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

export const LlmCall = CallSummary.extend({ input: z.string(), output: z.string().nullable(), parsed: z.unknown() });
export type LlmCall = z.infer<typeof LlmCall>;

export const CallDetail = z.object({ call: LlmCall, claims: z.array(Claim), proposals: z.array(NameProposal).default([]) });
export type CallDetail = z.infer<typeof CallDetail>;

export const TopicCount = z.object({ topic: z.string(), count: z.number() });
export type TopicCount = z.infer<typeof TopicCount>;

export const Topics = z.object({ from: z.number(), to: z.number(), topics: z.array(TopicCount) });
export type Topics = z.infer<typeof Topics>;

export const Snapshot = z.object({
  session: Session,
  segments: z.array(Segment),
  health: Health.nullable(),
  speakers: z.array(Speaker),
  // A deliberate read-side difference from the backend: the frontend deploys on Vercel before the box's api rolls forward, and a page must still parse the older snapshot in that window.
  claims: z.array(Claim).default([]),
  calls: z.array(CallSummary).default([]),
  cost_usd: z.number().default(0),
  seq: z.number(),
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
]);
export type LiveEvent = z.infer<typeof LiveEvent>;
