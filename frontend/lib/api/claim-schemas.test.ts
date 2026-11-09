import { expect, test } from "vitest";

import { ClaimSearch } from "./claim-schemas";

test("ClaimSearch parses a page and refuses a hit without its speaker", () => {
  const lean = { bullish: 1, bearish: 0, neutral: 0, none: 0 };
  const hit = {
    id: 1, session_id: "s", call_id: 2, speaker_id: "S2", t0: 5, t1: 6, claim: "c", topics: ["rates"], polarity: "bullish", quote: "q",
    quote_verified: true, status: "ok", created_at: "2026-09-28T00:00:00.000Z", speaker: { id: "S1", name: "Anders Persson", role: null },
  };
  const page = {
    total: 1, as_of: 9, offset: 0, next_offset: null, items: [hit], lean,
    shows: [{ session_id: "s", video_id: "v", source_file: null, created_at: "2026-09-28T00:00:00.000Z", started_at: null, count: 1 }],
    topics: [{ value: "rates", count: 1, lean, voices: ["Anders Persson"] }],
    speakers: [{ name: "Anders Persson", count: 1, lean, topics: ["rates"] }],
    session_speakers: { s: [] },
  };
  expect(ClaimSearch.parse(page).items[0]!.speaker.name).toBe("Anders Persson");
  const bare: Partial<typeof hit> = { ...hit };
  delete bare.speaker;
  expect(ClaimSearch.safeParse({ ...page, items: [bare] }).success).toBe(false);
});
