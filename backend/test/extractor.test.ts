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

test("a failed tick keeps the cursor and the next tick tries the same lines again; the fresh part never reaches back more than extract_max_s", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    hub.subscribe(s.id, (e) => seen.push(e));
    await say(tx, s.id, 0, "first words");
    const llm = fakeLlm([new Error("llm-proxy unreachable"), claimsAnswer("late words")]);
    const extractor = createExtractor({ db: tx, hub, sessionId: s.id, llm: llm.client, config });

    await extractor.tick();
    expect(seen.map((e) => e.type)).toEqual(["call"]);
    expect(seen[0]?.type === "call" && seen[0].data.error).toBe("llm-proxy unreachable");

    await say(tx, s.id, 200, "late words");
    await extractor.tick();
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]?.user).not.toContain("first words");
    expect(llm.requests[1]?.user).toContain("[03:20 S1] late words");
    expect(seen.map((e) => e.type)).toEqual(["call", "call", "claims.new"]);
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
    expect(factory({ db: tx, hub, sessionId: s.id, config: { extract: false } })).toBeNull();
    expect(factory({ db: tx, hub, sessionId: s.id, config: { speed: 2 } })).not.toBeNull();
    expect(() => factory({ db: tx, hub, sessionId: s.id, config: { extract_prompt: "v99" } })).toThrow(/no prompt extract\/v99/);
    expect(() => factory({ db: tx, hub, sessionId: s.id, config: { extract_interval_s: -1 } })).toThrow();
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
