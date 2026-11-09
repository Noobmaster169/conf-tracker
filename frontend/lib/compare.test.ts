import { describe, expect, test } from "vitest";

import type { Claim } from "./api/schemas";
import { configDiff, matchClaims } from "./compare";

let nextId = 1;
const claim = (t0: number | null, text: string, session = "a"): Claim => ({
  id: nextId++, session_id: session, call_id: 1, speaker_id: "S1", t0, t1: t0 === null ? null : t0 + 3, claim: text, topics: [],
  polarity: "neutral", quote: text, quote_verified: true, status: "ok", created_at: "2026-09-29T00:00:00Z",
});

describe("matchClaims", () => {
  test("pairs near, similar claims and leaves the rest alone, in stream order", () => {
    const a1 = claim(10, "The Fed will cut rates twice this year");
    const a2 = claim(200, "Oil prices will climb");
    const b1 = claim(25, "The Fed will cut rates twice");
    const b2 = claim(90, "Gold is overbought");
    const pairs = matchClaims([a1, a2], [b1, b2]);
    expect(pairs.map((p) => [p.a?.id ?? null, p.b?.id ?? null])).toEqual([
      [a1.id, b1.id],
      [null, b2.id],
      [a2.id, null],
    ]);
  });

  test("a similar claim more than 30 s away is not a match", () => {
    const pairs = matchClaims([claim(10, "Oil prices will climb")], [claim(45, "Oil prices will climb")]);
    expect(pairs).toHaveLength(2);
  });

  test("one-to-one: two near-identical claims on one side take one partner each at most", () => {
    const a1 = claim(10, "Oil prices will climb");
    const b1 = claim(12, "Oil prices will climb");
    const b2 = claim(14, "Oil prices will climb higher");
    const pairs = matchClaims([a1], [b1, b2]);
    expect(pairs.filter((p) => p.a && p.b)).toEqual([{ a: a1, b: b1 }]);
    expect(pairs.filter((p) => !p.a).map((p) => p.b)).toEqual([b2]);
  });
});

test("configDiff lists changed, added and removed keys, sorted, without speed", () => {
  expect(configDiff({ speed: 1, match_threshold: 0.6, extract_model: "haiku" }, { speed: 0, match_threshold: 0.65, name_floor: 0.8 })).toEqual([
    { key: "extract_model", a: "haiku", b: undefined },
    { key: "match_threshold", a: 0.6, b: 0.65 },
    { key: "name_floor", a: undefined, b: 0.8 },
  ]);
});
