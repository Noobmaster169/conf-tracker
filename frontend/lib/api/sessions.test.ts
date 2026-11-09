import { expect, test } from "vitest";

import { LiveEvent, Session, Snapshot } from "./schemas";

const session = {
  id: "3f1d2e6a-0000-4000-8000-000000000001",
  source_url: "https://www.youtube.com/watch?v=QB5BNdBFujE",
  source_file: null,
  video_id: "QB5BNdBFujE",
  status: "live",
  started_at: "2026-09-23T10:00:00.000Z",
  stopped_at: null,
  config: {},
  models: { asr: "large-v3" },
  error: null,
  created_at: "2026-09-23T09:59:00.000Z",
};

test("Session mirrors the backend contract", () => {
  expect(Session.parse(session).video_id).toBe("QB5BNdBFujE");
  expect(Session.safeParse({ ...session, status: "paused" }).success).toBe(false);
});

test("Snapshot and LiveEvent parse a segment", () => {
  const segment = { id: 1, session_id: session.id, t0: 0, t1: 1, text: "hi", words: [{ w: "hi", t0: 0, t1: 1, p: 0.9, speaker_id: null }] };
  expect(Snapshot.parse({ session, segments: [segment], health: null, speakers: [], claims: [], calls: [], seq: 0 }).segments).toHaveLength(1);
  const event = LiveEvent.parse({ seq: 2, type: "segment", data: segment });
  expect(event.type === "segment" && event.data.text).toBe("hi");
});
