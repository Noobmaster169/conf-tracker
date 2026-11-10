import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { runExtraction } from "../src/agents/extract";
import { loadPrompt } from "../src/agents/prompts/registry";
import type { Claim } from "../src/contracts";
import { closePool } from "../src/db";
import type { Line } from "../src/pipeline/lines";
import type { Window } from "../src/pipeline/window";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import * as sessions from "../src/repositories/sessions";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const prompt = loadPrompt("extract", "v3");
const line = (t0: number, t1: number, text: string, speaker_id: string | null = "S1"): Line => ({ segment_id: 1, t0, t1, speaker_id, text });
const window: Window = {
  context: [line(0, 4, "Welcome back.", "S8")],
  fresh: [line(30, 36, "The Fed will cut in December, I think", "S11"), line(36, 40, "and oil is heading to ninety dollars.", null)],
  t0: 0,
  t1: 40,
};
const answer = (items: object[]) => JSON.stringify({ claims: items });
const fed = { claim: "The Fed will cut rates in December.", topics: ["fed", "rates"], polarity: "bearish", quote: "The Fed will cut in December" };

test("a verified quote gives the claim its speaker and time from the line, and every part is stored and published", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const llm = fakeLlm(answer([fed, { claim: "Oil will reach 90 dollars.", topics: ["oil"], polarity: "bullish", quote: "oil is heading to ninety dollars." }]));
    const result = await runExtraction({ db: tx, llm: llm.client, sessionId: s.id, prompt }, window, []);

    expect(result.call).toMatchObject({ session_id: s.id, step: "extract", prompt_version: "v3", model: "fake/sonnet", window_t0: 0, window_t1: 40, attempt: 1, error: null, claim_count: 2, input_tokens: 100, cost_usd: 0.001 });
    expect(result.claims.map((c) => [c.speaker_id, c.t0, c.t1, c.status, c.quote_verified])).toEqual([["S11", 30, 36, "ok", true], [null, 36, 40, "ok", true]]);
    expect(llm.requests[0]).toMatchObject({ model: "sonnet", outputSchema: { type: "object" } });
    expect(llm.requests[0]?.system).not.toContain("{{schema}}");
    expect(llm.requests[0]?.user).toBe("## already extracted\n(none)\n\n## context (already handled, for reference only)\n[00:00 S8] Welcome back.\n\n## new lines (extract from these)\n[00:30 S11] The Fed will cut in December, I think\n[00:36 --] and oil is heading to ninety dollars.");
    const stored = await calls.get(tx, result.call.id);
    expect(stored?.input).toBe(llm.requests[0]?.user);
    expect(stored?.parsed).toMatchObject(JSON.parse(answer([fed, { claim: "Oil will reach 90 dollars.", topics: ["oil"], polarity: "bullish", quote: "oil is heading to ninety dollars." }])));
    expect(await claims.forCall(tx, result.call.id)).toEqual(result.claims);
  });
});

test("an unverifiable quote is stored unverified with no speaker and no time; a repeat of a prior claim is a duplicate", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const prior: Claim = {
      id: 1, session_id: s.id, call_id: 1, speaker_id: "S11", t0: 30, t1: 36, claim: fed.claim, topics: fed.topics, polarity: "bearish",
      quote: fed.quote, quote_verified: true, status: "ok", kind: null, importance: null, created_at: "2026-09-28T00:00:00.000Z",
    };
    const llm = fakeLlm(answer([
      { ...fed, quote: "the Fed will cut in December" },
      { claim: "Oil will reach 90 dollars.", topics: ["oil"], polarity: "bullish", quote: "oil is heading to ninety dollars" },
      { claim: "Gold will hit 3000 dollars.", topics: ["gold"], polarity: "bullish", quote: "gold to three thousand" },
    ]));
    const result = await runExtraction({ db: tx, llm: llm.client, sessionId: s.id, prompt }, window, [prior]);
    expect(result.claims.map((c) => [c.status, c.quote_verified, c.speaker_id, c.t0])).toEqual([["duplicate", false, null, null], ["ok", true, null, 36], ["unverified", false, null, null]]);
    expect(llm.requests[0]?.user).toContain(`## already extracted\n- ${fed.claim}`);
  });
});

test("a failing call stores an error row and yields no claims, without throwing", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const llm = fakeLlm(new Error("llm-proxy returned 502: provider_not_logged_in"));
    const result = await runExtraction({ db: tx, llm: llm.client, sessionId: s.id, prompt }, window, []);
    expect(result.claims).toEqual([]);
    expect(result.call).toMatchObject({ error: "llm-proxy returned 502: provider_not_logged_in", claim_count: 0, input_tokens: null, cost_usd: null, model: "sonnet" });
    expect((await calls.get(tx, result.call.id))?.output).toBeNull();
  });
});

test("an answer outside the schema gets one more attempt that shows the mistake; each attempt is a row", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const llm = fakeLlm(['{"claims":[{"claim":"x","topics":[],"polarity":"up","quote":"x"}]}', answer([fed])]);
    const result = await runExtraction({ db: tx, llm: llm.client, sessionId: s.id, prompt }, window, []);
    expect(result.call.attempt).toBe(2);
    expect(result.claims).toHaveLength(1);
    expect(llm.requests[1]?.user).toMatch(/## your previous answer\n.*"polarity":"up".*\n\n## what was wrong with it\nclaims\.0\.polarity/s);
    const rows = await calls.latest(tx, s.id, 10);
    expect(rows.map((c) => [c.attempt, c.error === null])).toEqual([[1, false], [2, true]]);
  });
});

test("two bad answers end with the second row's error and no claims", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const llm = fakeLlm("not json at all");
    const result = await runExtraction({ db: tx, llm: llm.client, sessionId: s.id, prompt }, window, []);
    expect(llm.requests).toHaveLength(2);
    expect(result.claims).toEqual([]);
    expect(result.call).toMatchObject({ attempt: 2, claim_count: 0 });
    expect(result.call.error).toMatch(/\(root\)/);
  });
});

test("a session's claims never point at another session", async () => {
  await inRollback(async (tx) => {
    const a = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const b = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const llm = fakeLlm(answer([fed]));
    await runExtraction({ db: tx, llm: llm.client, sessionId: a.id, prompt }, window, []);
    expect(await claims.latest(tx, b.id, 10)).toEqual([]);
    expect((await claims.latest(tx, a.id, 10)).map((c) => c.session_id)).toEqual([a.id]);
  });
});

test("names reach the window after the speaker id, and the evidence check still reads the words alone", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const llm = fakeLlm(answer([fed]));
    const result = await runExtraction({ db: tx, llm: llm.client, sessionId: s.id, prompt }, window, [], new Map([["S11", "Cathie Wood"]]));
    expect(llm.requests[0]?.user).toContain("[00:30 S11 Cathie Wood] The Fed will cut in December, I think");
    expect(result.claims.map((c) => [c.speaker_id, c.status])).toEqual([["S11", "ok"]]);
  });
});
