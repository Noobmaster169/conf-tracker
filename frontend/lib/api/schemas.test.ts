import { expect, test } from "vitest";

import { Claim, LiveEvent, Snapshot } from "./schemas";

const claim = {
  id: 1, session_id: "s", call_id: 7, speaker_id: "S1", t0: 12, t1: 15, claim: "Rates will fall.", topics: ["rates"],
  polarity: "bearish", quote: "rates will fall", quote_verified: true, status: "ok", created_at: "2026-09-28T00:00:00.000Z",
};
const call = {
  id: 7, session_id: "s", step: "extract", prompt_version: "v1", model: "sonnet", window_t0: 0, window_t1: 30, attempt: 1,
  input_tokens: 10, output_tokens: 5, cost_usd: 0.001, latency_ms: 800, error: null, claim_count: 1, created_at: "2026-09-28T00:00:00.000Z",
};

test("claims, calls and the two new events parse like the backend's contract", () => {
  expect(Claim.parse(claim).polarity).toBe("bearish");
  expect(LiveEvent.parse({ seq: 1, type: "claims.new", data: [claim] }).type).toBe("claims.new");
  expect(LiveEvent.parse({ seq: 2, type: "call", data: call }).type).toBe("call");
  expect(Snapshot.safeParse({ session: {}, segments: [], health: null, speakers: [], seq: 0 }).success).toBe(false);
});

test("an older backend's snapshot without claims and calls parses with both empty", () => {
  const session = {
    id: "s", source_url: null, source_file: null, video_id: null, status: "live", started_at: null, stopped_at: null,
    config: {}, models: {}, error: null, created_at: "2026-09-28T00:00:00.000Z",
  };
  const parsed = Snapshot.parse({ session, segments: [], health: null, speakers: [], seq: 0 });
  expect(parsed.claims).toEqual([]);
  expect(parsed.calls).toEqual([]);
});

test("an older backend's snapshot still parses, with every later field defaulted", () => {
  const session = { id: "s", source_url: null, source_file: "x", video_id: null, status: "live", started_at: null, stopped_at: null, config: {}, models: {}, error: null, created_at: "2026-09-29T00:00:00.000Z" };
  const oldSpeaker = { speaker_id: "S1", first_seen_t: 0, last_seen_t: 1, talk_s: 1, merged_into: null };
  const parsed = Snapshot.parse({ session, segments: [], health: null, speakers: [oldSpeaker], claims: [], calls: [], seq: 0 });
  expect(parsed.cost_usd).toBe(0);
  expect(parsed.speakers[0]).toMatchObject({ name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null });
  expect(parsed.speakers[0]?.person_id).toBeNull();
  // Before the conference layer: no stage, no schedule, no kind on a claim.
  expect(parsed).toMatchObject({ stage: null, talks: [], spans: [], people: [] });
  expect(parsed.session).toMatchObject({ stage_id: null, title: null });
  expect(Claim.parse(claim)).toMatchObject({ kind: null, importance: null });
});

test("the timeline and people events parse", () => {
  const span = { id: 3, session_id: "s", talk_id: 9, state: "talk", t0: 10, t1: null, confidence: 0.9, source: "tracker" };
  expect(LiveEvent.parse({ seq: 4, type: "span", data: span }).type).toBe("span");
  expect(LiveEvent.parse({ seq: 5, type: "person", data: { id: 1, name: "Lily Liu", org: null, title: null, photo_url: null } }).type).toBe("person");
});
