import { z } from "zod";

import { Person, Span, Stage, Talk } from "./contracts-conference";

/**
 * Every shape that crosses a boundary: what speech sends, what the api answers,
 * what SSE carries. The frontend mirrors these by hand in lib/api/. snake_case
 * on the wire everywhere.
 *
 * One file on purpose: the frontend mirrors it line by line, so it may pass the 200 line limit.
 */

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const Word = z.object({
  w: z.string(),
  t0: z.number(),
  t1: z.number(),
  p: z.number(),
  speaker_id: z.string().nullable(),
});
export type Word = z.infer<typeof Word>;

export const SpeechWord = Word.omit({ speaker_id: true });
export type SpeechWord = z.infer<typeof SpeechWord>;
export const SessionConfig = z.record(z.string(), z.unknown());

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

export const SpeechEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.started"),
    session_id: z.string(),
    started_at: z.string(),
    source: z.record(z.string(), z.string()),
    models: z.record(z.string(), z.string()),
    config: SessionConfig,
    // Stream seconds. A speech image from before resume omits both.
    start_at: z.number().default(0),
    broadcast_start: z.number().nullable().default(null),
  }),
  z.object({ type: z.literal("asr.segment"), t0: z.number(), t1: z.number(), text: z.string(), words: z.array(SpeechWord) }),
  z.object({
    type: z.literal("health"),
    t: z.number(),
    lag_s: z.number(),
    gpu_ms_asr: z.number(),
    // A speech image from before diarization omits it.
    gpu_ms_diar: z.number().default(0),
    buffer_s: z.number(),
    behind_s: z.number().nullable().default(null),
  }),
  z.object({ type: z.literal("diar.turns"), window: DiarWindow, turns: z.array(Turn), matches: z.array(Match), gpu_ms: z.number() }),
  z.object({ type: z.literal("speaker.new"), speaker_id: z.string(), first_seen_t: z.number() }),
  z.object({ type: z.literal("speaker.merged"), speaker_id: z.string(), into: z.string(), score: z.number() }),
  z.object({ type: z.literal("session.ended"), reason: z.enum(["stopped", "source_ended", "error"]), message: z.string().default("") }),
]);
export type SpeechEvent = z.infer<typeof SpeechEvent>;
export type DiarTurnsEvent = Extract<SpeechEvent, { type: "diar.turns" }>;
export type SpeakerNewEvent = Extract<SpeechEvent, { type: "speaker.new" }>;
export type SpeakerMergedEvent = Extract<SpeechEvent, { type: "speaker.merged" }>;

export const StartMessage = z.object({
  session_id: z.string(),
  url: z.string().optional(),
  file: z.string().optional(),
  replay_of: z.string().optional(),
  speed: z.number().optional(),
  config: SessionConfig,
  start_at: z.number().optional(),
  stop_at: z.number().optional(),
  registry_from: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  speaker_floor: z.number().int().min(0).optional(),
  max_speed: z.number().positive().optional(),
  record: z.boolean().optional(),
});
export type StartMessage = z.infer<typeof StartMessage>;

export const SessionStatus = z.enum(["starting", "live", "recovering", "degraded", "stopped"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: z.string(),
  source_url: z.string().nullable(),
  source_file: z.string().nullable(),
  replay_of: z.string().nullable(),
  video_id: z.string().nullable(),
  status: SessionStatus,
  started_at: z.string().nullable(),
  stopped_at: z.string().nullable(),
  config: SessionConfig,
  models: z.record(z.string(), z.string()),
  error: z.string().nullable(),
  created_at: z.string(),
  stage_id: z.string().nullable(),
  title: z.string().nullable(),
  attention: z.string().nullable(),
  recovering_since: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

export const Leg = z.object({
  id: z.number(),
  session_id: z.string(),
  speech_id: z.string(),
  kind: z.enum(["main", "gap"]),
  requested_t: z.number(),
  start_t: z.number().nullable(),
  end_t: z.number().nullable(),
  opened_at: z.string(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
});
export type Leg = z.infer<typeof Leg>;

export const Gap = z.object({
  id: z.number(),
  session_id: z.string(),
  t0: z.number(),
  t1: z.number(),
  filled_at: z.string().nullable(),
  created_at: z.string(),
  // Why the recording could not fill it, once filling was given up.
  note: z.string().nullable().default(null),
  // The last step of its fill done: transcribed, tracked, named, extracted, summarised; null before the transcript.
  stage: z.enum(["transcribed", "tracked", "named", "extracted", "summarised"]).nullable().default(null),
  stage_at: z.string().nullable().default(null),
  tried_at: z.string().nullable().default(null),
  since: z.string().nullable().default(null),
});
export type GapStage = NonNullable<Gap["stage"]>;
export type Gap = z.infer<typeof Gap>;

export const Segment = z.object({
  id: z.number(),
  session_id: z.string(),
  t0: z.number(),
  t1: z.number(),
  text: z.string(),
  words: z.array(Word),
});
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

export const Speaker = z.object({
  speaker_id: z.string(),
  first_seen_t: z.number(),
  last_seen_t: z.number(),
  talk_s: z.number(),
  merged_into: z.string().nullable(),
  name: z.string().nullable(),
  role: z.string().nullable(),
  name_confidence: z.number().nullable(),
  name_quote: z.string().nullable(),
  name_call_id: z.number().nullable(),
  person_id: z.number().nullable(),
});
export type Speaker = z.infer<typeof Speaker>;

export const WindowRecord = z.object({ id: z.number(), t0: z.number(), t1: z.number(), gpu_ms: z.number(), matches: z.array(Match) });
export type WindowRecord = z.infer<typeof WindowRecord>;

export const ProposalStatus = z.enum(["accepted", "rejected"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

// One name the model proposed for a speaker, and what the judge made of it (backend/src/pipeline/naming.ts).
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

export const SpeakerDetail = z.object({ speaker: Speaker, windows: z.array(WindowRecord), proposals: z.array(NameProposal) });
export type SpeakerDetail = z.infer<typeof SpeakerDetail>;

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
  kind: ClaimKind.nullable(),
  importance: z.number().nullable(),
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

export const CallDetail = z.object({ call: LlmCall, claims: z.array(Claim), proposals: z.array(NameProposal) });
export type CallDetail = z.infer<typeof CallDetail>;

// Extraction settings, read out of session.config so a replay can change them without a deploy. Unknown keys are ignored.
export const ExtractConfig = z.object({
  extract: z.boolean().default(true),
  extract_interval_s: z.number().min(1).default(30), // on stream time every boundary a segment passes queues a run; below a second that is a flood of them
  context_tail_s: z.number().nonnegative().default(60),
  extract_max_s: z.number().positive().default(120),
  dedupe_n: z.number().int().nonnegative().default(20),
  extract_model: z.string().min(1).default("sonnet"),
  extract_prompt: z.string().regex(/^v\d+$/).default("v5"),
});
export type ExtractConfig = z.infer<typeof ExtractConfig>;

// Naming settings, read out of session.config like ExtractConfig. Unknown keys are ignored.
export const NameConfig = z.object({
  name: z.boolean().default(true),
  name_interval_s: z.number().min(5).default(60), // each tick is a model call when anyone is unnamed; faster than this buys nothing
  name_window_s: z.number().positive().default(180),
  name_floor: z.number().min(0).max(1).default(0.7),
  // Measured on the claude -p rail: haiku thought for 40 to 105 s a call and named on weaker evidence; sonnet took 5 to 10 s.
  name_model: z.string().min(1).default("sonnet"),
  name_prompt: z.string().regex(/^v\d+$/).default("v3"),
});
export type NameConfig = z.infer<typeof NameConfig>;

export const TopicCount = z.object({ topic: z.string(), count: z.number() });
export type TopicCount = z.infer<typeof TopicCount>;

export const Topics = z.object({ from: z.number(), to: z.number(), topics: z.array(TopicCount) });
export type Topics = z.infer<typeof Topics>;

// GET /claims: every claim across sessions, filtered, with facets counted over the same filtered set.
export const Lean = z.object({ bullish: z.number(), bearish: z.number(), neutral: z.number(), none: z.number() });
export type Lean = z.infer<typeof Lean>;

// A claim with its speaker resolved through merges: id is the survivor, name and role are the survivor's.
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

// The query string of GET /claims, after repeated keys are gathered into arrays by the route.
export const ClaimSearchQuery = z.object({
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  topic: z.array(z.string().trim().min(1)).default([]),
  speaker: z.array(z.string().min(1)).default([]),
  polarity: z.array(Polarity).default([]),
  session: z.array(z.uuid()).default([]),
  all: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  as_of: z.coerce.number().int().positive().optional(),
});
export type ClaimSearchQuery = z.output<typeof ClaimSearchQuery>;

export const CreateSessionBody = z
  .object({
    url: z.url().optional(),
    file: z.string().min(1).optional(),
    speed: z.number().nonnegative().optional(),
    config: SessionConfig.optional(),
    stage_id: z.uuid().optional(),
  })
  .refine((body) => (body.url === undefined) !== (body.file === undefined), { message: "exactly one of url or file" });
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

// A null config value removes the key from the original's config, so the replay falls back to the default.
export const ReplayBody = z.object({ config: SessionConfig.optional(), speed: z.number().nonnegative().optional() });
export type ReplayBody = z.infer<typeof ReplayBody>;

// PATCH /claims/:id: a correction by hand. Only the fields sent change; `speaker_id` null leaves the claim with no speaker.
export const ClaimPatch = z
  .object({
    claim: z.string().trim().min(1).max(600),
    kind: ClaimKind,
    importance: z.number().int().min(1).max(5),
    topics: z.array(z.string().trim().min(1).max(60)).max(8),
    polarity: Polarity,
    speaker_id: z.string().min(1).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "nothing to change" });
export type ClaimPatch = z.infer<typeof ClaimPatch>;

// PUT /sessions/:id/speakers/:sid: who a voice is, said by hand. Exactly one of: a known person, a name (the person is
// found or made), null to take the name away, or another voice of the video this one really is.
export const SpeakerCorrection = z
  .object({
    person_id: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(200).nullable().optional(),
    org: z.string().trim().max(200).nullish(),
    title: z.string().trim().max(200).nullish(),
    merge_into: z.string().min(1).optional(),
  })
  .refine((body) => [body.person_id !== undefined, body.name !== undefined, body.merge_into !== undefined].filter(Boolean).length === 1, {
    message: "send exactly one of person_id, name or merge_into",
  });
export type SpeakerCorrection = z.infer<typeof SpeakerCorrection>;

// PATCH /sessions/:id: what a video is called on its card.
export const SessionPatch = z.object({ title: z.string().trim().min(1).max(300).nullable() });
export type SessionPatch = z.infer<typeof SessionPatch>;

export * from "./contracts-conference";

export const Snapshot = z.object({
  session: Session,
  segments: z.array(Segment),
  health: Health.nullable(),
  speakers: z.array(Speaker),
  claims: z.array(Claim),
  calls: z.array(CallSummary),
  cost_usd: z.number(),
  seq: z.number(),
  stage: Stage.nullable(),
  talks: z.array(Talk),
  spans: z.array(Span),
  people: z.array(Person),
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
