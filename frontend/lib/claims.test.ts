import { expect, test } from "vitest";

import type { CallSummary, Claim } from "./api/schemas";
import { claimTime, lastCallLine, polarityGlyph } from "./claims";

const claim = (t0: number | null): Claim => ({
  id: 1, session_id: "s", call_id: 1, speaker_id: null, t0, t1: t0, claim: "c", topics: [], polarity: "none", quote: "q",
  quote_verified: t0 !== null, status: t0 === null ? "unverified" : "ok", created_at: "2026-09-28T00:00:00.000Z",
});
const call = (over: Partial<CallSummary>): CallSummary => ({
  id: 3, session_id: "s", step: "extract", prompt_version: "v1", model: "sonnet", window_t0: 0, window_t1: 30, attempt: 1,
  input_tokens: 10, output_tokens: 5, cost_usd: 0.0123, latency_ms: 2140, error: null, claim_count: 2, created_at: "2026-09-28T00:00:00.000Z", ...over,
});

test("polarity glyphs and tones", () => {
  expect(polarityGlyph("bullish")).toEqual({ glyph: "▲", label: "bullish", tone: "live" });
  expect(polarityGlyph("bearish")).toEqual({ glyph: "▼", label: "bearish", tone: "bad" });
  expect(polarityGlyph("neutral")).toEqual({ glyph: "●", label: "neutral", tone: "dim" });
  expect(polarityGlyph("none")).toEqual({ glyph: "○", label: "no polarity", tone: "faint" });
});

test("claimTime is the stream time or a placeholder", () => {
  expect(claimTime(claim(65))).toBe("01:05");
  expect(claimTime(claim(null))).toBe("--:--");
});

test("lastCallLine summarises the last call, names a failure, and is null before any call", () => {
  expect(lastCallLine(undefined)).toBeNull();
  expect(lastCallLine(call({}))).toEqual({ text: "last call 00:00-00:30 · 2 claims · 2.1s · $0.0123", failed: false });
  expect(lastCallLine(call({ claim_count: 1, cost_usd: null }))).toEqual({ text: "last call 00:00-00:30 · 1 claim · 2.1s", failed: false });
  expect(lastCallLine(call({ error: "llm-proxy unreachable at http://llm-proxy:4000", claim_count: 0 }))).toEqual({
    text: "last call 00:00-00:30 failed: llm-proxy unreachable at http://llm-proxy:4000",
    failed: true,
  });
});
