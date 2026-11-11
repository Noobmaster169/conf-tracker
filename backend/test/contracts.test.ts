import { expect, test } from "vitest";

import { CallSummary, Claim, CreateSessionBody, ExtractConfig, LiveEvent, NameConfig, NameProposal, Snapshot, SpeechEvent, StartMessage } from "../src/contracts";

test("SpeechEvent parses what speech sends and rejects the rest", () => {
  const segment = SpeechEvent.parse({ type: "asr.segment", t0: 1, t1: 2, text: "hi", words: [{ w: "hi", t0: 1, t1: 2, p: 0.9 }] });
  expect(segment.type).toBe("asr.segment");
  const ended = SpeechEvent.parse({ type: "session.ended", reason: "error" });
  expect(ended.type === "session.ended" && ended.message).toBe("");
  expect(SpeechEvent.safeParse({ type: "diar.turns" }).success).toBe(false);
});

test("CreateSessionBody needs exactly one of url or file", () => {
  expect(CreateSessionBody.safeParse({ url: "https://youtube.com/watch?v=QB5BNdBFujE" }).success).toBe(true);
  expect(CreateSessionBody.safeParse({ file: "/data/x.wav", speed: 0 }).success).toBe(true);
  expect(CreateSessionBody.safeParse({}).success).toBe(false);
  expect(CreateSessionBody.safeParse({ url: "https://a.b", file: "x" }).success).toBe(false);
  expect(CreateSessionBody.safeParse({ url: "nope" }).success).toBe(false);
});

test("LiveEvent discriminates on type", () => {
  const parsed = LiveEvent.parse({
    seq: 3,
    type: "health",
    data: { t: 1, lag_s: 2, gpu_ms_asr: 3, gpu_ms_diar: 0, buffer_s: 4, received_at: "2026-09-23T00:00:00.000Z" },
  });
  expect(parsed.type).toBe("health");
  expect(LiveEvent.safeParse({ seq: 1, type: "segment", data: {} }).success).toBe(false);
});

test("speech speaker events parse, and health without gpu_ms_diar defaults to 0", () => {
  const turns = SpeechEvent.parse({
    type: "diar.turns",
    window: { t0: 0, t1: 60 },
    turns: [{ t0: 1, t1: 4.2, speaker_id: "S1" }],
    matches: [{ local: "SPEAKER_00", speech_s: 24.9, speaker_id: "S1", scores: { S1: 0.98 }, new: false }],
    gpu_ms: 1612.3,
  });
  expect(turns.type).toBe("diar.turns");
  expect(SpeechEvent.parse({ type: "speaker.new", speaker_id: "S3", first_seen_t: 31.2 }).type).toBe("speaker.new");
  expect(SpeechEvent.parse({ type: "speaker.merged", speaker_id: "S5", into: "S2", score: 0.81 }).type).toBe("speaker.merged");
  const health = SpeechEvent.parse({ type: "health", t: 1, lag_s: 0, gpu_ms_asr: 1, buffer_s: 0 });
  expect(health.type === "health" && health.gpu_ms_diar).toBe(0);
});

test("ExtractConfig fills every default from an empty session config and rejects bad values", () => {
  expect(ExtractConfig.parse({})).toEqual({
    extract: true, extract_interval_s: 30, context_tail_s: 60, extract_max_s: 120, dedupe_n: 20, extract_model: "sonnet", extract_prompt: "v5",
  });
  expect(ExtractConfig.parse({ speed: 2, extract_model: "haiku" }).extract_model).toBe("haiku");
  expect(ExtractConfig.safeParse({ extract_interval_s: 0 }).success).toBe(false);
  expect(ExtractConfig.safeParse({ extract_interval_s: 0.5 }).success).toBe(false);
  expect(ExtractConfig.safeParse({ extract_prompt: "latest" }).success).toBe(false);
});

test("claim and call events parse and the snapshot carries both lists", () => {
  const claim = {
    id: 1, session_id: "s", call_id: 7, speaker_id: null, t0: null, t1: null, claim: "x", topics: ["fed"],
    polarity: "none", quote: "x", quote_verified: false, status: "unverified", kind: null, importance: null, created_at: "2026-09-28T00:00:00.000Z",
  };
  expect(Claim.parse(claim).status).toBe("unverified");
  expect(Claim.safeParse({ ...claim, polarity: "up" }).success).toBe(false);
  const call = {
    id: 7, session_id: "s", step: "extract", prompt_version: "v1", model: "sonnet", window_t0: 0, window_t1: 30, attempt: 1,
    input_tokens: 10, output_tokens: 5, cost_usd: 0.001, latency_ms: 800, error: null, claim_count: 1, created_at: "2026-09-28T00:00:00.000Z",
  };
  expect(CallSummary.parse(call).claim_count).toBe(1);
  expect(LiveEvent.parse({ seq: 1, type: "claims.new", data: [claim] }).type).toBe("claims.new");
  expect(LiveEvent.parse({ seq: 2, type: "call", data: call }).type).toBe("call");
  expect(Snapshot.safeParse({ session: {}, segments: [], health: null, speakers: [], seq: 0 }).success).toBe(false);
});

test("NameConfig fills every default from an empty session config and rejects bad values", () => {
  expect(NameConfig.parse({})).toEqual({ name: true, name_interval_s: 60, name_window_s: 180, name_floor: 0.7, name_model: "sonnet", name_prompt: "v3" });
  expect(NameConfig.safeParse({ name_floor: 1.5 }).success).toBe(false);
  expect(NameConfig.safeParse({ name_interval_s: 1 }).success).toBe(false);
  expect(NameConfig.safeParse({ name_prompt: "latest" }).success).toBe(false);
});

test("a proposal parses, and the snapshot needs the session cost", () => {
  const proposal = {
    id: 1, session_id: "s", call_id: 2, speaker_id: "S3", name: "Cathie Wood", role: null, confidence: 0.9,
    quote: "joining us is Cathie Wood", quote_verified: true, status: "accepted", reason: null, created_at: "2026-09-29T00:00:00.000Z",
  };
  expect(NameProposal.parse(proposal)).toEqual(proposal);
  expect(NameProposal.safeParse({ ...proposal, status: "maybe" }).success).toBe(false);
  const session = {
    id: "s", source_url: null, source_file: "x.wav", replay_of: null, video_id: null, status: "live", started_at: null, stopped_at: null,
    config: {}, models: {}, error: null, created_at: "2026-09-29T00:00:00.000Z", stage_id: null, title: null, attention: null, recovering_since: null,
  };
  const snapshot = { session, segments: [], health: null, speakers: [], claims: [], calls: [], seq: 0, stage: null, talks: [], spans: [], people: [] };
  expect(Snapshot.safeParse(snapshot).success).toBe(false);
  expect(Snapshot.parse({ ...snapshot, cost_usd: 0.25 }).cost_usd).toBe(0.25);
});

test("session.started and health parse without the resume fields", () => {
  const started = SpeechEvent.parse({ type: "session.started", session_id: "s", started_at: "2026-11-12T00:00:00.000Z", source: {}, models: {}, config: {} });
  expect(started.type === "session.started" && [started.start_at, started.broadcast_start]).toEqual([0, null]);
  const health = SpeechEvent.parse({ type: "health", t: 1, lag_s: 0, gpu_ms_asr: 0, buffer_s: 0 });
  expect(health.type === "health" && health.behind_s).toBeNull();
  const withBehind = SpeechEvent.parse({ type: "health", t: 1, lag_s: 0, gpu_ms_asr: 0, buffer_s: 0, behind_s: 12.5 });
  expect(withBehind.type === "health" && withBehind.behind_s).toBe(12.5);
});

test("StartMessage mirrors the optional resume fields", () => {
  expect(StartMessage.safeParse({ session_id: "s", config: {} }).success).toBe(true);
  expect(StartMessage.safeParse({ session_id: "s", config: {}, start_at: 10, stop_at: 20, registry_from: "abc_1-2", speaker_floor: 3, max_speed: 3, record: false }).success).toBe(true);
  expect(StartMessage.safeParse({ session_id: "s", config: {}, registry_from: "bad id!" }).success).toBe(false);
  expect(StartMessage.safeParse({ session_id: "s", config: {}, speaker_floor: -1 }).success).toBe(false);
  expect(StartMessage.safeParse({ session_id: "s", config: {}, max_speed: 0 }).success).toBe(false);
});
