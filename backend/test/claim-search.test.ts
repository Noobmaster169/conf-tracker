import type { PoolClient } from "pg";
import { afterAll, expect, test } from "vitest";

import { ClaimSearchQuery } from "../src/contracts";
import { closePool } from "../src/db";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import { search, UNNAMED } from "../src/repositories/claim-search";
import * as sessions from "../src/repositories/sessions";
import { inRollback } from "./db";

afterAll(closePool);

const call: calls.NewCall = {
  step: "extract", promptVersion: "v2", model: "sonnet", windowT0: 0, windowT1: 30, attempt: 1, input: "x", output: "{}", parsed: {},
  inputTokens: 1, outputTokens: 1, costUsd: 0.001, latencyMs: 10, error: null,
};
type Seed = { speaker: string | null; t0: number | null; topics: string[]; polarity: claims.NewClaim["polarity"]; claim: string; quote?: string; status?: claims.NewClaim["status"] };
const claim = (s: Seed): claims.NewClaim => ({
  speakerId: s.speaker, t0: s.t0, t1: s.t0 === null ? null : s.t0 + 1, claim: s.claim, topics: s.topics, polarity: s.polarity,
  quote: s.quote ?? s.claim.toLowerCase(), quoteVerified: (s.status ?? "ok") !== "unverified", status: s.status ?? "ok",
});

/** Session A (older): S1 named, S2 → S3 → S1 merged, S6 unnamed. Session B (newer): S1 named. */
async function seed(tx: PoolClient) {
  const a = await sessions.create(tx, { sourceUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA", sourceFile: null, config: {} });
  const b = await sessions.create(tx, { sourceUrl: "https://www.youtube.com/watch?v=BBBBBBBBBBB", sourceFile: null, config: {} });
  await tx.query("update sessions set created_at = $2 where id = $1", [a.id, "2026-09-27T10:00:00Z"]);
  await tx.query("update sessions set created_at = $2 where id = $1", [b.id, "2026-09-28T10:00:00Z"]);
  await tx.query(
    `insert into speakers (session_id, speaker_id, first_seen_t, last_seen_t, name, role, merged_into) values
     ($1, 'S1', 0, 60, 'Anders Persson', 'CIO', null), ($1, 'S2', 0, 60, null, null, 'S3'),
     ($1, 'S3', 0, 60, null, null, 'S1'), ($1, 'S6', 0, 60, null, null, null),
     ($2, 'S1', 0, 60, 'Helima Croft', null, null)`,
    [a.id, b.id],
  );
  const ca = await calls.insert(tx, a.id, call);
  const cb = await calls.insert(tx, b.id, call);
  const [a1, a2, a3, a4, a5] = await claims.insertMany(tx, a.id, ca.id, [
    claim({ speaker: "S1", t0: 10, topics: ["rates", "Fed"], polarity: "bullish", claim: "The Fed cuts twice" }),
    claim({ speaker: "S2", t0: 5, topics: ["rates"], polarity: "bearish", claim: "Long yields rise", quote: "the long end has 50%_ further" }),
    claim({ speaker: "S6", t0: 20, topics: ["oil"], polarity: "neutral", claim: "Brent sits at 70" }),
    claim({ speaker: null, t0: null, topics: ["rates"], polarity: "bullish", claim: "Unplaced", status: "unverified" }),
    claim({ speaker: "S1", t0: 30, topics: ["rates"], polarity: "bullish", claim: "The Fed cuts twice again", status: "duplicate" }),
  ]);
  const [b1, b2] = await claims.insertMany(tx, b.id, cb.id, [
    claim({ speaker: "S1", t0: 3, topics: ["oil"], polarity: "bearish", claim: "OPEC adds supply" }),
    claim({ speaker: "S1", t0: 1, topics: ["Oil", "iran"], polarity: "bearish", claim: "Supply risk from the Gulf" }),
  ]);
  return { a, b, cb, a1: a1!, a2: a2!, a3: a3!, a4: a4!, a5: a5!, b1: b1!, b2: b2! };
}

const q = (s: { a: { id: string }; b: { id: string } }, over: Record<string, unknown> = {}) =>
  ClaimSearchQuery.parse({ session: [s.a.id, s.b.id], ...over });
const texts = (r: { items: { claim: string }[] }) => r.items.map((i) => i.claim);

test("default: ok claims only, newest session first, stream order within, speakers resolved through two merges", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const r = await search(tx, q(s));
    expect(r.total).toBe(5);
    expect(texts(r)).toEqual(["Supply risk from the Gulf", "OPEC adds supply", "Long yields rise", "The Fed cuts twice", "Brent sits at 70"]);
    expect(r.items[2]!.speaker).toEqual({ id: "S1", name: "Anders Persson", role: "CIO" });
    expect(r.items[2]!.speaker_id).toBe("S2");
    expect(r.items[4]!.speaker).toEqual({ id: "S6", name: null, role: null });
    expect(r.lean).toEqual({ bullish: 1, bearish: 3, neutral: 1, none: 0 });
    expect(r.next_offset).toBeNull();
    expect(r.as_of).toBeGreaterThanOrEqual(s.b2.id);
  });
});

test("all=1 adds unverified and duplicates; an untimed claim sorts last in its session", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const r = await search(tx, q(s, { all: "1" }));
    expect(r.total).toBe(7);
    expect(texts(r).slice(2)).toEqual(["Long yields rise", "The Fed cuts twice", "Brent sits at 70", "The Fed cuts twice again", "Unplaced"]);
  });
});

test("facets are counted over the filtered set", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const r = await search(tx, q(s));
    expect(r.topics).toEqual([
      { value: "oil", count: 3, lean: { bullish: 0, bearish: 2, neutral: 1, none: 0 }, voices: ["Helima Croft"] },
      { value: "rates", count: 2, lean: { bullish: 1, bearish: 1, neutral: 0, none: 0 }, voices: ["Anders Persson"] },
      { value: "fed", count: 1, lean: { bullish: 1, bearish: 0, neutral: 0, none: 0 }, voices: ["Anders Persson"] },
      { value: "iran", count: 1, lean: { bullish: 0, bearish: 1, neutral: 0, none: 0 }, voices: ["Helima Croft"] },
    ]);
    expect(r.speakers).toEqual([
      { name: "Anders Persson", count: 2, lean: { bullish: 1, bearish: 1, neutral: 0, none: 0 }, topics: ["rates", "fed"] },
      { name: "Helima Croft", count: 2, lean: { bullish: 0, bearish: 2, neutral: 0, none: 0 }, topics: ["oil", "iran"] },
      { name: null, count: 1, lean: { bullish: 0, bearish: 0, neutral: 1, none: 0 }, topics: ["oil"] },
    ]);
    expect(r.shows.map((x) => [x.session_id, x.video_id, x.count])).toEqual([[s.b.id, "BBBBBBBBBBB", 2], [s.a.id, "AAAAAAAAAAA", 3]]);
    expect(Object.keys(r.session_speakers).sort()).toEqual([s.a.id, s.b.id].sort());
    expect(r.session_speakers[s.a.id]!.map((x) => x.speaker_id)).toEqual(["S1", "S2", "S3", "S6"]);

    const oil = await search(tx, q(s, { topic: ["OIL"] }));
    expect(oil.total).toBe(3);
    expect(oil.speakers.map((x) => x.name)).toEqual(["Helima Croft", null]);
  });
});

test("each filter alone and combined", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    expect(texts(await search(tx, q(s, { speaker: ["Anders Persson"] })))).toEqual(["Long yields rise", "The Fed cuts twice"]);
    expect(texts(await search(tx, q(s, { speaker: [UNNAMED] })))).toEqual(["Brent sits at 70"]);
    expect(texts(await search(tx, q(s, { speaker: [UNNAMED], all: "1" })))).toEqual(["Brent sits at 70", "Unplaced"]);
    expect((await search(tx, q(s, { speaker: [UNNAMED, "Helima Croft"] }))).total).toBe(3);
    expect(texts(await search(tx, q(s, { polarity: ["bearish"] })))).toEqual(["Supply risk from the Gulf", "OPEC adds supply", "Long yields rise"]);
    expect(texts(await search(tx, q(s, { topic: ["oil"], polarity: ["bearish"] })))).toEqual(["Supply risk from the Gulf", "OPEC adds supply"]);
    expect(texts(await search(tx, q(s, { session: [s.a.id], topic: ["rates", "oil"] })))).toEqual(["Long yields rise", "The Fed cuts twice", "Brent sits at 70"]);
  });
});

test("q matches claim, quote or topic, case-insensitively, with % _ and \\ taken literally", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    expect(texts(await search(tx, q(s, { q: "opec" })))).toEqual(["OPEC adds supply"]);
    expect(texts(await search(tx, q(s, { q: "IRAN" })))).toEqual(["Supply risk from the Gulf"]);
    expect(texts(await search(tx, q(s, { q: "50%_" })))).toEqual(["Long yields rise"]);
    expect(texts(await search(tx, q(s, { q: "%" })))).toEqual(["Long yields rise"]);
    expect(texts(await search(tx, q(s, { q: "_" })))).toEqual(["Long yields rise"]);
    expect((await search(tx, q(s, { q: "\\" }))).total).toBe(0);
  });
});

test("pages hold still while claims arrive: as_of pins the set", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const first = await search(tx, q(s, { limit: "2" }));
    expect(texts(first)).toEqual(["Supply risk from the Gulf", "OPEC adds supply"]);
    expect(first.next_offset).toBe(2);
    await claims.insertMany(tx, s.b.id, s.cb.id, [claim({ speaker: "S1", t0: 0, topics: ["oil"], polarity: "bullish", claim: "Arrived later" })]);
    const second = await search(tx, q(s, { limit: "2", offset: "2", as_of: String(first.as_of) }));
    expect(second.total).toBe(5);
    expect(texts(second)).toEqual(["Long yields rise", "The Fed cuts twice"]);
    expect(second.next_offset).toBe(4);
    const last = await search(tx, q(s, { limit: "2", offset: "4", as_of: String(first.as_of) }));
    expect(texts(last)).toEqual(["Brent sits at 70"]);
    expect(last.next_offset).toBeNull();
    expect(Object.keys(last.session_speakers)).toEqual([s.a.id]);
  });
});

test("sessions created in the same instant still order the same way every time", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    await tx.query("update sessions set created_at = $2 where id = any($1::uuid[])", [[s.a.id, s.b.id], "2026-09-28T10:00:00Z"]);
    const one = texts(await search(tx, q(s)));
    const two = texts(await search(tx, q(s)));
    expect(one).toEqual(two);
    const firstSession = [s.a.id, s.b.id].sort()[0];
    expect((await search(tx, q(s))).items[0]!.session_id).toBe(firstSession);
  });
});

test("nothing matching answers empty facets", async () => {
  await inRollback(async (tx) => {
    const s = await seed(tx);
    const r = await search(tx, q(s, { q: "no such words" }));
    expect(r).toMatchObject({ total: 0, items: [], topics: [], speakers: [], shows: [], next_offset: null, session_speakers: {} });
    expect(r.lean).toEqual({ bullish: 0, bearish: 0, neutral: 0, none: 0 });
  });
});

test("a replay's claims count nowhere", async () => {
  await inRollback(async (tx) => {
    const orig = await sessions.create(tx, { sourceUrl: "https://www.youtube.com/watch?v=CCCCCCCCCCC", sourceFile: null, config: {} });
    const replay = await sessions.create(tx, { sourceUrl: orig.source_url, sourceFile: null, config: {}, replayOf: orig.id });
    for (const s of [orig, replay]) {
      const c = await calls.insert(tx, s.id, call);
      await claims.insertMany(tx, s.id, c.id, [claim({ speaker: null, t0: 5, topics: ["oil"], polarity: "neutral", claim: "Oil climbs" })]);
    }
    // Scoped to these two sessions: other suites leave committed oil claims in the test database.
    const result = await search(tx, ClaimSearchQuery.parse({ session: [orig.id, replay.id], topic: ["oil"] }));
    expect(result.total).toBe(1);
    expect(result.shows.map((s) => s.session_id)).toEqual([orig.id]);
  });
});
