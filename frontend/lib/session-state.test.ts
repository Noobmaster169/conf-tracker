import { expect, test } from "vitest";

import type { Segment, Snapshot } from "./api/schemas";
import { applyEvent, initialState, setConnection } from "./session-state";

const session: Snapshot["session"] = {
  id: "s",
  source_url: null,
  source_file: "x.wav",
  replay_of: null,
  video_id: null,
  status: "live",
  started_at: null,
  stopped_at: null,
  config: {},
  models: {},
  error: null,
  created_at: "2026-09-23T00:00:00.000Z",
};
const seg = (id: number, t0: number, text = "x"): Segment => ({ id, session_id: "s", t0, t1: t0 + 1, text, words: [] });
const snapshot: Snapshot = { session, segments: [seg(1, 0), seg(2, 5)], health: null, speakers: [], claims: [], calls: [], cost_usd: 0, seq: 2 };

test("initial state comes from the snapshot, connecting", () => {
  const state = initialState(snapshot);
  expect(state.segments.map((s) => s.id)).toEqual([1, 2]);
  expect(state.connection).toBe("connecting");
  expect(state.seq).toBe(2);
});

test("a segment is inserted in time order and replaced by id", () => {
  let state = initialState(snapshot);
  state = applyEvent(state, { seq: 3, type: "segment", data: seg(3, 2.5) });
  expect(state.segments.map((s) => s.t0)).toEqual([0, 2.5, 5]);
  state = applyEvent(state, { seq: 4, type: "segment", data: seg(3, 2.5, "corrected") });
  expect(state.segments).toHaveLength(3);
  expect(state.segments[1]?.text).toBe("corrected");
  expect(state.seq).toBe(4);
});

test("health and session events replace their slot", () => {
  let state = initialState(snapshot);
  state = applyEvent(state, { seq: 3, type: "health", data: { t: 1, lag_s: 2, gpu_ms_asr: 3, gpu_ms_diar: 0, buffer_s: 4, received_at: "now" } });
  expect(state.health?.lag_s).toBe(2);
  state = applyEvent(state, { seq: 4, type: "session", data: { ...session, status: "degraded" } });
  expect(state.session.status).toBe("degraded");
});

test("a snapshot event replaces everything but the connection", () => {
  let state = setConnection(initialState(snapshot), "open");
  state = applyEvent(state, { seq: 9, type: "snapshot", data: { ...snapshot, segments: [seg(7, 30)], seq: 9 } });
  expect(state.segments.map((s) => s.id)).toEqual([7]);
  expect(state.seq).toBe(9);
  expect(state.connection).toBe("open");
});

import type { Speaker } from "./api/schemas";
import { activeSpeakers, resolveSpeaker, speakerResolver, speakersHeading } from "./session-state";

const spk = (speaker_id: string, first_seen_t: number, merged_into: string | null = null): Speaker => ({
  speaker_id, first_seen_t, last_seen_t: first_seen_t, talk_s: 0, merged_into,
  name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null,
});

test("speaker events upsert by id and keep first-seen order", () => {
  let state = initialState(snapshot);
  state = applyEvent(state, { seq: 3, type: "speaker", data: spk("S2", 9) });
  state = applyEvent(state, { seq: 4, type: "speaker", data: spk("S1", 1) });
  state = applyEvent(state, { seq: 5, type: "speaker", data: { ...spk("S2", 9), talk_s: 4 } });
  expect(state.speakers.map((s) => [s.speaker_id, s.talk_s])).toEqual([["S1", 0], ["S2", 4]]);
});

const said = (id: number, ...speakerIds: (string | null)[]): Segment => ({
  ...seg(id, 5),
  words: speakerIds.map((speaker_id, i) => ({ w: `w${i}`, t0: 5 + i, t1: 5.5 + i, p: 1, speaker_id })),
});
const updated = (seq: number, data: Segment) => ({ seq, type: "segment.updated" as const, data });

test("segment.updated replaces the segment and flashes when a labelled word changes speaker", () => {
  let state = initialState({ ...snapshot, segments: [said(2, "S1", "S1")] });
  state = applyEvent(state, updated(7, { ...said(2, "S1", "S2"), text: "relabelled" }));
  expect(state.segments[0]?.text).toBe("relabelled");
  expect(state.revisions).toEqual({ 2: 7 });
});

test("first-time labelling does not flash", () => {
  let state = initialState({ ...snapshot, segments: [said(2, null, null)] });
  state = applyEvent(state, updated(7, said(2, "S1", "S1")));
  expect(state.segments[0]?.words.map((x) => x.speaker_id)).toEqual(["S1", "S1"]);
  expect(state.revisions).toEqual({});
});

test("a merge rename does not flash, and a later no-op keeps the earlier revision", () => {
  const speakers = [spk("S8", 0), spk("S13", 1, "S8")];
  let state = initialState({ ...snapshot, speakers, segments: [said(2, "S1", "S13")] });
  state = applyEvent(state, updated(7, said(2, "S2", "S13")));
  expect(state.revisions).toEqual({ 2: 7 });
  state = applyEvent(state, updated(8, said(2, "S2", "S8")));
  expect(state.segments[0]?.words[1]?.speaker_id).toBe("S8");
  expect(state.revisions).toEqual({ 2: 7 });
});

test("an unseen segment arriving as segment.updated does not flash", () => {
  const state = applyEvent(initialState(snapshot), updated(7, said(9, "S1")));
  expect(state.segments.map((s) => s.id)).toContain(9);
  expect(state.revisions).toEqual({});
});

test("resolveSpeaker follows merged_into", () => {
  const speakers = [spk("S1", 0), spk("S2", 1, "S1"), spk("S3", 2, "S2")];
  expect(resolveSpeaker(speakers, "S3")).toBe("S1");
  expect(resolveSpeaker(speakers, "S1")).toBe("S1");
  expect(resolveSpeaker(speakers, null)).toBeNull();
  expect(resolveSpeaker(speakers, "S9")).toBe("S9");
});

test("activeSpeakers are those with a turn in the last seconds of the latest window", () => {
  let state = initialState({ ...snapshot, speakers: [spk("S1", 0), spk("S2", 0, "S1"), spk("S3", 0)] });
  state = applyEvent(state, {
    seq: 3,
    type: "turns",
    data: { window: { t0: 0, t1: 60 }, turns: [{ t0: 10, t1: 20, speaker_id: "S3" }, { t0: 52, t1: 58, speaker_id: "S2" }] },
  });
  expect([...activeSpeakers(state)]).toEqual(["S1"]);
});

test("speakerResolver resolves every id once, like resolveSpeaker", () => {
  const speakers = [spk("S1", 0), spk("S2", 1, "S1"), spk("S3", 2, "S2")];
  const resolve = speakerResolver(speakers);
  expect([resolve("S3"), resolve("S2"), resolve("S1"), resolve("S9"), resolve(null)]).toEqual(["S1", "S1", "S1", "S9", null]);
});

test("speakersHeading counts distinct speakers and notes merges", () => {
  expect(speakersHeading([])).toBe("speakers");
  expect(speakersHeading([spk("S1", 0), spk("S2", 1)])).toBe("speakers 2");
  expect(speakersHeading([spk("S1", 0), spk("S2", 1, "S1"), spk("S3", 2)])).toBe("speakers 2 (+1 merged)");
});

import type { CallSummary, Claim } from "./api/schemas";

const claimAt = (id: number, t0: number | null): Claim => ({
  id, session_id: "s", call_id: 1, speaker_id: t0 === null ? null : "S1", t0, t1: t0 === null ? null : t0 + 2, claim: `c${id}`, topics: [],
  polarity: "none", quote: "q", quote_verified: t0 !== null, status: t0 === null ? "unverified" : "ok", created_at: "2026-09-28T00:00:00.000Z",
});
const callAt = (id: number, error: string | null = null): CallSummary => ({
  id, session_id: "s", step: "extract", prompt_version: "v1", model: "sonnet", window_t0: 0, window_t1: 30, attempt: 1,
  input_tokens: 10, output_tokens: 5, cost_usd: 0.001, latency_ms: 800, error, claim_count: error ? 0 : 1, created_at: "2026-09-28T00:00:00.000Z",
});

test("claims.new appends new claims once, oldest first, and a call event keeps the last ten", () => {
  let state = initialState({ ...snapshot, claims: [claimAt(1, 5)], calls: [callAt(1)] });
  state = applyEvent(state, { seq: 3, type: "claims.new", data: [claimAt(2, 30), claimAt(3, null)] });
  state = applyEvent(state, { seq: 4, type: "claims.new", data: [claimAt(2, 30)] });
  expect(state.claims.map((c) => c.id)).toEqual([1, 2, 3]);
  for (let i = 2; i <= 12; i++) state = applyEvent(state, { seq: 4 + i, type: "call", data: callAt(i, i === 12 ? "boom" : null) });
  expect(state.calls.map((c) => c.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  expect(state.calls.at(-1)?.error).toBe("boom");
  expect(state.seq).toBe(16);
});

test("a snapshot event replaces claims and calls too", () => {
  let state = initialState({ ...snapshot, claims: [claimAt(1, 5)], calls: [callAt(1)] });
  state = applyEvent(state, { seq: 9, type: "snapshot", data: { ...snapshot, claims: [claimAt(7, 90)], calls: [], seq: 9 } });
  expect(state.claims.map((c) => c.id)).toEqual([7]);
  expect(state.calls).toEqual([]);
});

test("the session cost starts from the snapshot and grows by each newer call once", () => {
  let state = initialState({ ...snapshot, cost_usd: 0.5 });
  const call = {
    id: 9, session_id: "s", step: "name", prompt_version: "v1", model: "haiku", window_t0: 0, window_t1: 30, attempt: 1,
    input_tokens: 1, output_tokens: 1, cost_usd: 0.25, latency_ms: 1000, error: null, claim_count: 0, created_at: "2026-09-29T00:00:00.000Z",
  };
  state = applyEvent(state, { seq: 3, type: "call", data: call });
  expect(state.costUsd).toBe(0.75);
  state = applyEvent(state, { seq: 3, type: "call", data: call });
  expect(state.costUsd).toBe(0.75);
  state = applyEvent(state, { seq: 4, type: "call", data: { ...call, id: 10, cost_usd: null, error: "llm-proxy unreachable" } });
  expect(state.costUsd).toBe(0.75);
});

test("a live segment records when it arrived; a snapshot's segments have no arrival", () => {
  let state = initialState(snapshot);
  expect(state.arrivals).toEqual({});
  state = applyEvent(state, { seq: 3, type: "segment", data: seg(3, 9) }, 12_345);
  expect(state.arrivals).toEqual({ 3: 12_345 });
  state = applyEvent(state, { seq: 4, type: "segment", data: seg(3, 9, "again") }, 99_999);
  expect(state.arrivals).toEqual({ 3: 12_345 });
});

test("a live segment the snapshot already delivered records no arrival, so the delay does not hide it again", () => {
  const known = snapshot.segments[0]!;
  const state = applyEvent(initialState(snapshot), { seq: 3, type: "segment", data: { ...known, text: "again" } }, 12_345);
  expect(state.arrivals).toEqual({});
});
