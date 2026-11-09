import { afterAll, expect, test } from "vitest";

import { closePool } from "../src/db";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import * as sessions from "../src/repositories/sessions";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const newSession = (tx: Parameters<typeof sessions.create>[0]) => sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });

const newCall = (error: string | null = null): calls.NewCall => ({
  step: "extract", promptVersion: "v1", model: "sonnet", windowT0: 0, windowT1: 30, attempt: 1,
  input: "## new lines\n[00:01 S1] rates will fall", output: error ? null : '{"claims":[]}', parsed: error ? null : { claims: [] },
  inputTokens: error ? null : 120, outputTokens: error ? null : 9, costUsd: error ? null : 0.002, latencyMs: 750, error,
});
const newClaim = (claim: string, status: claims.NewClaim["status"] = "ok"): claims.NewClaim => ({
  speakerId: status === "ok" ? "S1" : null, t0: status === "ok" ? 1 : null, t1: status === "ok" ? 3 : null,
  claim, topics: ["rates"], polarity: "bearish", quote: "rates will fall", quoteVerified: status === "ok", status,
});

test("insert returns the full call, get finds it, latest lists summaries oldest first with claim counts", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const first = await calls.insert(tx, s.id, newCall());
    expect(first).toMatchObject({ step: "extract", prompt_version: "v1", attempt: 1, claim_count: 0, error: null, parsed: { claims: [] } });
    expect(typeof first.id).toBe("number");
    await claims.insertMany(tx, s.id, first.id, [newClaim("a"), newClaim("b", "unverified")]);
    const failed = await calls.insert(tx, s.id, newCall("llm-proxy unreachable"));
    expect((await calls.get(tx, first.id))?.claim_count).toBe(2);
    expect(await calls.get(tx, 987654321)).toBeNull();
    const summaries = await calls.latest(tx, s.id, 10);
    expect(summaries.map((c) => [c.id, c.claim_count, c.error])).toEqual([[first.id, 2, null], [failed.id, 0, "llm-proxy unreachable"]]);
    expect("input" in summaries[0]!).toBe(false);
    expect(calls.toSummary(first, 2)).toEqual(summaries[0]);
  });
});

test("claims keep input order, list filters by t0 but keeps unverified ones, latest and forCall answer", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const call = await calls.insert(tx, s.id, newCall());
    const stored = await claims.insertMany(tx, s.id, call.id, [
      { ...newClaim("early"), t0: 1, t1: 2 }, { ...newClaim("late"), t0: 50, t1: 52 }, newClaim("nowhere", "unverified"), newClaim("again", "duplicate"),
    ]);
    expect(stored.map((c) => c.claim)).toEqual(["early", "late", "nowhere", "again"]);
    expect(stored[0]).toMatchObject({ call_id: call.id, speaker_id: "S1", topics: ["rates"], polarity: "bearish", quote_verified: true, status: "ok" });
    expect(stored[2]).toMatchObject({ speaker_id: null, t0: null, quote_verified: false, status: "unverified" });
    expect((await claims.list(tx, s.id, { from: 10, to: 60 })).map((c) => c.claim)).toEqual(["late", "nowhere", "again"]);
    expect((await claims.latest(tx, s.id, 2)).map((c) => c.claim)).toEqual(["nowhere", "again"]);
    expect((await claims.forCall(tx, call.id)).length).toBe(4);
    expect(await claims.insertMany(tx, s.id, call.id, [])).toEqual([]);
  });
});

test("topicCounts counts the topics of claims timed in range, lower-cased, skipping duplicates and untimed claims", async () => {
  await inRollback(async (tx) => {
    const s = await newSession(tx);
    const call = await calls.insert(tx, s.id, newCall());
    const at = (t0: number, topics: string[], status: claims.NewClaim["status"] = "ok"): claims.NewClaim => ({
      ...newClaim(`claim at ${t0} ${topics.join(" ")}`, status), t0: status === "unverified" ? null : t0, t1: status === "unverified" ? null : t0 + 2, topics,
    });
    await claims.insertMany(tx, s.id, call.id, [
      at(10, ["rates", "fed"]), at(20, ["Rates"]), at(30, ["oil"]), at(40, ["rates"], "duplicate"), at(0, ["gold"], "unverified"), at(900, ["rates"]),
    ]);
    expect(await claims.topicCounts(tx, s.id, { from: 0, to: 600 })).toEqual([
      { topic: "rates", count: 2 },
      { topic: "fed", count: 1 },
      { topic: "oil", count: 1 },
    ]);
    expect(await claims.topicCounts(tx, s.id, { from: 0, to: 600, limit: 1 })).toEqual([{ topic: "rates", count: 2 }]);
  });
});
