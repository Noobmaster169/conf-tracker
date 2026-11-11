import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import type { LlmClient, LlmRequest } from "../src/agents/llm-client";
import { ExtractConfig, type LiveEvent } from "../src/contracts";
import { closePool } from "../src/db";
import { createExtractor, extractorFactory } from "../src/ingest/extractor";
import { createHub } from "../src/realtime/hub";
import * as calls from "../src/repositories/calls";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as speakersRepo from "../src/repositories/speakers";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const config = ExtractConfig.parse({ extract_interval_s: 1, context_tail_s: 60, extract_max_s: 120 });
const say = (db: Parameters<typeof segments.insert>[0], sessionId: string, t0: number, text: string, speaker: string | null = "S1") =>
  segments.insert(db, sessionId, { t0, t1: t0 + 5, text, words: text.split(" ").map((w, i) => ({ w, t0: t0 + i, t1: t0 + i + 0.5, p: 1, speaker_id: speaker })) });
const claimsAnswer = (quote: string) => JSON.stringify({ claims: [{ claim: `Claim about ${quote}`, topics: ["t"], polarity: "neutral", quote }] });

test("a tick extracts the fresh lines, publishes call and claims.new, and the next tick skips what it already covered", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    hub.subscribe(s.id, (e) => seen.push(e));
    await say(tx, s.id, 0, "rates will fall");
    const llm = fakeLlm([claimsAnswer("rates will fall"), claimsAnswer("oil is up")]);
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config });

    await extractor.tick();
    expect(seen.map((e) => e.type)).toEqual(["call", "claims.new"]);
    expect(seen[0]?.type === "call" && seen[0].data).toMatchObject({ window_t0: 0, window_t1: 2.5, claim_count: 1, error: null });
    expect(seen[1]?.type === "claims.new" && seen[1].data.map((c) => [c.speaker_id, c.t0, c.status])).toEqual([["S1", 0, "ok"]]);
    expect(llm.requests[0]?.user).toContain("## new lines (extract from these)\n[00:00 S1] rates will fall");

    await extractor.tick();
    expect(llm.requests).toHaveLength(1);

    await say(tx, s.id, 30, "oil is up");
    await extractor.tick();
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.user).toContain("## context (already handled, for reference only)\n[00:00 S1] rates will fall\n\n## new lines (extract from these)\n[00:30 S1] oil is up");
    expect(llm.requests[1]?.user).toContain("## already extracted\n- Claim about rates will fall");
    expect((await calls.latest(tx, s.id, 10)).map((c) => c.claim_count)).toEqual([1, 1]);
  });
});

test("a failed tick keeps the cursor and the next tick tries the same lines again before anything later", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    hub.subscribe(s.id, (e) => seen.push(e));
    await say(tx, s.id, 0, "first words");
    const llm = fakeLlm([new Error("llm-proxy unreachable"), claimsAnswer("first words"), claimsAnswer("late words")]);
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config });

    await extractor.tick();
    expect(seen.map((e) => e.type)).toEqual(["call"]);
    expect(seen[0]?.type === "call" && seen[0].data.error).toBe("llm-proxy unreachable");

    await say(tx, s.id, 200, "late words");
    await extractor.tick();
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.user).toContain("[00:00 S1] first words");
    expect(llm.requests[1]?.user).not.toContain("late words");
    await extractor.tick();
    expect(llm.requests[2]?.user).toContain("## new lines (extract from these)\n[03:20 S1] late words");
    expect(seen.map((e) => e.type)).toEqual(["call", "call", "claims.new", "call", "claims.new"]);
  });
});

const NO_CLAIMS = JSON.stringify({ claims: [] });
const freshStart = (request: LlmRequest | undefined) => request?.user.split("## new lines (extract from these)\n")[1]?.slice(1, 6);
const answered = async (db: Parameters<typeof calls.latest>[0], sessionId: string) =>
  (await calls.latest(db, sessionId, 100)).filter((c) => c.step === "extract").map((c) => [c.window_t1, c.error === null]);

test("a new extractor picks up after the last answered window and drains the backlog in order", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    for (let t = 0; t < 700; t += 10) await say(tx, s.id, t, `w${t}`);
    await calls.insert(tx, s.id, {
      step: "extract", promptVersion: "v1", model: "haiku", windowT0: 180, windowT1: 300, attempt: 1, input: "x", output: null, parsed: null,
      inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: null,
    });
    await calls.insert(tx, s.id, {
      step: "extract", promptVersion: "v1", model: "haiku", windowT0: 300, windowT1: 500, attempt: 1, input: "x", output: null, parsed: null,
      inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: "llm-proxy unreachable",
    });
    const llm = fakeLlm(NO_CLAIMS);
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config });

    expect(await extractor.drain()).toBe(true);
    expect(llm.requests.map(freshStart)).toEqual(["05:00", "07:00", "09:00", "11:00"]);
    expect(llm.requests[0]?.user.split("## new lines")[1]).not.toContain("w290");
    expect((await answered(tx, s.id)).slice(2)).toEqual([[410.5, true], [530.5, true], [650.5, true], [690.5, true]]);
    expect(await extractor.drain()).toBe(true);
    expect(llm.requests).toHaveLength(4);
  });
});

test("drain stops at a failed call and leaves the cursor; the next drain resumes there", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    for (let t = 0; t < 300; t += 10) await say(tx, s.id, t, `w${t}`);
    const llm = fakeLlm([NO_CLAIMS, new Error("llm-proxy unreachable"), NO_CLAIMS]);
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config });

    expect(await extractor.drain()).toBe(false);
    expect(llm.requests.map(freshStart)).toEqual(["00:00", "02:00"]);
    expect(await extractor.drain()).toBe(true);
    expect(llm.requests.map(freshStart)).toEqual(["00:00", "02:00", "02:00", "04:00"]);
    expect(await answered(tx, s.id)).toEqual([[110.5, true], [230.5, false], [230.5, true], [290.5, true]]);
  });
});

test("a stream-time run only sees lines that ended by its boundary", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await say(tx, s.id, 0, "rates will fall"); // ends at 5
    await say(tx, s.id, 8, "oil is up"); // ends at 13
    const llm = fakeLlm([claimsAnswer("rates will fall"), claimsAnswer("oil is up")]);
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config });
    await extractor.tick(10);
    expect(llm.requests[0]?.user).toContain("rates will fall");
    expect(llm.requests[0]?.user).not.toContain("oil is up");
    await extractor.tick(20);
    expect(llm.requests[1]?.user).toContain("oil is up");
  });
});

test("a tick after stop does nothing", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await say(tx, s.id, 0, "words");
    const llm = fakeLlm(claimsAnswer("words"));
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config });
    extractor.stop();
    await extractor.tick();
    expect(llm.requests).toHaveLength(0);
  });
});

test("the factory reads the session config, answers null when extraction is off, and refuses a missing prompt version", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(10);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const factory = extractorFactory(fakeLlm("x").client);
    expect(factory({ db: tx, hub, sessionId: s.id, config: { extract: false }, resumeAt: 0 })).toBeNull();
    expect(factory({ db: tx, hub, sessionId: s.id, config: { speed: 2 }, resumeAt: 0 })).not.toBeNull();
    expect(() => factory({ db: tx, hub, sessionId: s.id, config: { extract_prompt: "v99" }, resumeAt: 0 })).toThrow(/no prompt extract\/v99/);
    expect(() => factory({ db: tx, hub, sessionId: s.id, config: { extract_interval_s: -1 }, resumeAt: 0 })).toThrow();
  });
});

test("flush waits for the tick in flight and then extracts what arrived meanwhile", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await say(tx, s.id, 0, "rates will fall");
    const requests: LlmRequest[] = [];
    let entered: () => void = () => undefined;
    const inCall = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const llm: LlmClient = {
      async complete(request) {
        requests.push(request);
        entered();
        await gate;
        const text = claimsAnswer(requests.length === 1 ? "rates will fall" : "oil is up");
        return { text, model: "fake/x", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, latencyMs: 1 };
      },
    };
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm, config });

    const ticking = extractor.tick();
    await inCall;
    await say(tx, s.id, 30, "oil is up");
    const flushing = extractor.flush();
    release();
    await Promise.all([ticking, flushing]);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("[00:30 S1] oil is up");
  });
});

test("the extractor puts known names into its window", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await say(tx, s.id, 0, "rates will fall", "S1");
    await speakersRepo.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 5 });
    const call = await calls.insert(tx, s.id, {
      step: "name", promptVersion: "v1", model: "haiku", windowT0: 0, windowT1: 5, attempt: 1, input: "x", output: null, parsed: null,
      inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: null,
    });
    await speakersRepo.setName(tx, s.id, "S1", { name: "Tom Keene", role: "host", confidence: 0.9, quote: "x", callId: call.id });
    const llm = fakeLlm(claimsAnswer("rates will fall"));
    await createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config }).tick();
    expect(llm.requests[0]?.user).toContain("[00:00 S1 Tom Keene] rates will fall");
  });
});
