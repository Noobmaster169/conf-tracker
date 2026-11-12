import { afterAll, expect, it } from "vitest";

import { closePool } from "../src/db";
import { attemptsOf, effectsFor, listRuns, recentStatuses, statusOf } from "../src/repositories/agent-runs";
import * as claims from "../src/repositories/claims";
import * as names from "../src/repositories/names";
import * as spans from "../src/repositories/spans";
import * as stages from "../src/repositories/stages";
import * as summaries from "../src/repositories/summaries";
import * as talks from "../src/repositories/talks";
import { aCall, aVideo } from "./agents-helpers";
import { inRollback } from "./db";

afterAll(closePool);

const SLOW = 60_000;
const list = (db: Parameters<typeof listRuns>[0], over: Partial<Parameters<typeof listRuns>[1]> = {}) => listRuns(db, { agentId: "extract", limit: 50, slowMs: SLOW, ...over });

it("a failed attempt followed by its corrected one is one run, shown as the last attempt", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    await aCall(tx, v.id, { error: "claims: Required", parsed: null });
    const second = await aCall(tx, v.id, { attempt: 2 });
    const runs = await list(tx, { sessionId: v.id });
    expect(runs.map((r) => [r.id, r.attempt])).toEqual([[second.id, 2]]);
    expect(statusOf(runs[0]!, SLOW)).toBe("ok");
  });
});

it("two failed attempts are one failed run", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    await aCall(tx, v.id, { error: "claims: Required", parsed: null });
    await aCall(tx, v.id, { attempt: 2, error: "claims: Required", parsed: null });
    const runs = await list(tx, { sessionId: v.id });
    expect(runs).toHaveLength(1);
    expect(statusOf(runs[0]!, SLOW)).toBe("failed");
  });
});

it("status filters: failed, slow by threshold, and failed beats slow", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const ok = await aCall(tx, v.id, { windowT1: 30 });
    const slow = await aCall(tx, v.id, { windowT0: 30, windowT1: 60, latencyMs: 70_000 });
    const failedAndSlow = await aCall(tx, v.id, { windowT0: 60, windowT1: 90, latencyMs: 70_000, error: "boom", parsed: null });
    expect(statusOf(slow, SLOW)).toBe("slow");
    expect(statusOf(failedAndSlow, SLOW)).toBe("failed");
    expect(statusOf(ok, SLOW)).toBe("ok");
    expect((await list(tx, { sessionId: v.id, status: "failed" })).map((r) => r.id)).toEqual([failedAndSlow.id]);
    expect((await list(tx, { sessionId: v.id, status: "slow" })).map((r) => r.id)).toEqual([slow.id]);
    expect((await list(tx, { sessionId: v.id })).map((r) => r.id)).toEqual([failedAndSlow.id, slow.id, ok.id]);
  });
});

it("pages by id and never returns input or output", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const a = await aCall(tx, v.id, { windowT1: 30, input: "x".repeat(200_000) });
    const b = await aCall(tx, v.id, { windowT0: 30, windowT1: 60 });
    const c = await aCall(tx, v.id, { windowT0: 60, windowT1: 90 });
    const first = await list(tx, { sessionId: v.id, limit: 2 });
    expect(first.map((r) => r.id)).toEqual([c.id, b.id]);
    expect((await list(tx, { sessionId: v.id, limit: 2, before: b.id })).map((r) => r.id)).toEqual([a.id]);
    expect(Object.keys((await list(tx, { sessionId: v.id }))[2]!)).not.toContain("input");
    expect(Object.keys(first[0]!)).not.toContain("output");
    expect(first[0]!.session_title).toBe("Main Stage");
  });
});

it("only the asked agent's runs are listed", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    await aCall(tx, v.id, { step: "track" });
    const mine = await aCall(tx, v.id);
    expect((await list(tx, { sessionId: v.id })).map((r) => r.id)).toEqual([mine.id]);
  });
});

it("effects: claims counted, accepted names listed, the span and the summary found by call id", async () => {
  await inRollback(async (tx) => {
    const stage = await stages.create(tx, { conference: "Test Conf", name: "Main", day: "2026-11-16", description: "" });
    const talk = await talks.create(tx, stage.id, { title: "DePIN panel", description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [] });
    const v = await aVideo(tx, { stageId: stage.id });
    const extract = await aCall(tx, v.id);
    const claim = { speakerId: null, t0: 1, t1: 2, claim: "c", topics: [], polarity: "none" as const, kind: "fact" as const, importance: 2, quote: "q", quoteVerified: true, status: "ok" as const };
    await claims.insertMany(tx, v.id, extract.id, [claim, { ...claim, claim: "d" }]);
    const name = await aCall(tx, v.id, { step: "name" });
    const proposal = { speakerId: "S2", name: "Kevin B.", role: null, confidence: 0.9, quote: "I'm Kevin", quoteVerified: true, status: "accepted" as const, reason: null };
    await names.insertMany(tx, v.id, name.id, [proposal, { ...proposal, speakerId: "S4", name: "Nobody", status: "rejected" as const, reason: "weak" }]);
    const track = await aCall(tx, v.id, { step: "track" });
    await spans.switchTo(tx, v.id, { talkId: talk.id, state: "talk", t: 10, confidence: 0.9, quote: null, source: "tracker", callId: track.id });
    const summary = await aCall(tx, v.id, { step: "summarize" });
    await summaries.insert(tx, { talkId: talk.id, sessionId: v.id, callId: summary.id, summary: { headline: "H", content: "C" } });
    const plain = await aCall(tx, v.id, { windowT0: 30, windowT1: 60 });

    const effects = await effectsFor(tx, [extract.id, name.id, track.id, summary.id, plain.id]);
    expect(effects.get(extract.id)).toEqual({ claims: 2, named: [], switchedTo: null, summaryOf: null });
    expect(effects.get(name.id)!.named).toEqual([{ voice: "S2", name: "Kevin B." }]);
    expect(effects.get(track.id)!.switchedTo).toBe("DePIN panel");
    expect(effects.get(summary.id)!.summaryOf).toBe("DePIN panel");
    expect(effects.get(plain.id)).toEqual({ claims: 0, named: [], switchedTo: null, summaryOf: null });
    expect((await effectsFor(tx, [])).size).toBe(0);
  });
});

it("recentStatuses answers oldest first and [] for an agent that never ran", async () => {
  await inRollback(async (tx) => {
    await tx.query("delete from llm_calls where step = 'zz_never'");
    expect(await recentStatuses(tx, "zz_never", 24, SLOW)).toEqual([]);
    const v = await aVideo(tx);
    await aCall(tx, v.id, { step: "zz_test", windowT1: 30, error: "boom", parsed: null });
    await aCall(tx, v.id, { step: "zz_test", windowT0: 30, windowT1: 60 });
    await aCall(tx, v.id, { step: "zz_test", windowT0: 60, windowT1: 90, latencyMs: 70_000 });
    expect((await recentStatuses(tx, "zz_test", 24, SLOW)).map((r) => r.status)).toEqual(["failed", "ok", "slow"]);
    expect((await recentStatuses(tx, "zz_test", 2, SLOW)).map((r) => r.status)).toEqual(["ok", "slow"]);
  });
});

it("attemptsOf answers every attempt of a call's run, oldest first, from either attempt", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const first = await aCall(tx, v.id, { error: "bad", parsed: null });
    const second = await aCall(tx, v.id, { attempt: 2 });
    const other = await aCall(tx, v.id, { windowT0: 30, windowT1: 60 });
    expect(await attemptsOf(tx, second.id)).toEqual([first.id, second.id]);
    expect(await attemptsOf(tx, first.id)).toEqual([first.id, second.id]);
    expect(await attemptsOf(tx, other.id)).toEqual([other.id]);
  });
});
