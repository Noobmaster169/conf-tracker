import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { runNaming } from "../src/agents/name";
import { loadPrompt } from "../src/agents/prompts/registry";
import { closePool } from "../src/db";
import type { Line } from "../src/pipeline/lines";
import { selectNameWindow } from "../src/pipeline/naming";
import * as calls from "../src/repositories/calls";
import * as names from "../src/repositories/names";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const prompt = loadPrompt("name", "v1");
const line = (t0: number, speaker_id: string, text: string): Line => ({ segment_id: 1, t0, t1: t0 + 4, speaker_id, text });
const lines = [line(60, "S1", "Joining us now is Cathie Wood of Ark Invest."), line(64, "S2", "Thanks for having me, Tom.")];
const answer = (proposals: object[]) => JSON.stringify({ proposals });

async function seed(tx: Parameters<typeof sessions.create>[0]) {
  const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
  await speakers.upsert(tx, s.id, { speakerId: "S1", firstSeenT: 60, lastSeenT: 64 });
  await speakers.upsert(tx, s.id, { speakerId: "S2", firstSeenT: 64, lastSeenT: 68 });
  const roster = await speakers.list(tx, s.id);
  return { s, roster, window: selectNameWindow(lines, roster, { name_window_s: 180, name_floor: 0.7 })! };
}

test("an accepted proposal names the speaker with its quote and call, and the call and proposal are stored", async () => {
  await inRollback(async (tx) => {
    const { s, roster, window } = await seed(tx);
    const llm = fakeLlm(answer([
      { speaker_id: "S2", name: "Cathie Wood", role: "guest, CEO of Ark Invest", confidence: 0.93, quote: "Joining us now is Cathie Wood of Ark Invest." },
      { speaker_id: "S1", name: "Tom", role: "host", confidence: 0.72, quote: "Thanks for having me, Tom." },
    ]));
    const result = await runNaming({ db: tx, llm: llm.client, sessionId: s.id, prompt, floor: 0.7 }, window, roster);

    expect(result.call).toMatchObject({ step: "name", prompt_version: "v1", model: "fake/sonnet", window_t0: 60, window_t1: 68, error: null, claim_count: 0 });
    expect(llm.requests[0]).toMatchObject({ model: "sonnet", outputSchema: { type: "object" } });
    expect(llm.requests[0]?.user).toBe("## speakers\nS1: (unnamed)\nS2: (unnamed)\n\n## transcript\n[01:00 S1] Joining us now is Cathie Wood of Ark Invest.\n[01:04 S2] Thanks for having me, Tom.");
    expect(result.proposals.map((p) => [p.speaker_id, p.status])).toEqual([["S2", "accepted"], ["S1", "accepted"]]);
    expect(result.named.map((n) => [n.speaker_id, n.name, n.name_call_id])).toEqual([["S2", "Cathie Wood", result.call.id], ["S1", "Tom", result.call.id]]);
    expect(await speakers.get(tx, s.id, "S2")).toMatchObject({ name: "Cathie Wood", role: "guest, CEO of Ark Invest", name_confidence: 0.93, name_quote: "Joining us now is Cathie Wood of Ark Invest." });
    expect(await names.forCall(tx, result.call.id)).toEqual(result.proposals);
  });
});

test("a rejected proposal is stored with its reason and names nobody", async () => {
  await inRollback(async (tx) => {
    const { s, roster, window } = await seed(tx);
    const llm = fakeLlm(answer([{ speaker_id: "S2", name: "Jerome Powell", role: null, confidence: 0.4, quote: "Thanks for having me, Tom." }]));
    const result = await runNaming({ db: tx, llm: llm.client, sessionId: s.id, prompt, floor: 0.7 }, window, roster);
    expect(result.proposals.map((p) => [p.status, p.reason])).toEqual([["rejected", "confidence 0.40 is below the floor 0.70"]]);
    expect(result.named).toEqual([]);
    expect((await speakers.get(tx, s.id, "S2"))?.name).toBeNull();
  });
});

test("a failing naming call stores an error row and names nobody, without throwing; an empty answer is a good one", async () => {
  await inRollback(async (tx) => {
    const { s, roster, window } = await seed(tx);
    const down = await runNaming({ db: tx, llm: fakeLlm(new Error("llm-proxy unreachable")).client, sessionId: s.id, prompt, floor: 0.7 }, window, roster);
    expect(down).toMatchObject({ proposals: [], named: [] });
    expect(down.call.error).toBe("llm-proxy unreachable");
    const empty = await runNaming({ db: tx, llm: fakeLlm(answer([])).client, sessionId: s.id, prompt, floor: 0.7 }, window, roster);
    expect(empty).toMatchObject({ proposals: [], named: [] });
    expect(empty.call.error).toBeNull();
    expect((await calls.latest(tx, s.id, 10)).map((c) => c.step)).toEqual(["name", "name"]);
  });
});

test("a merge or a stronger name that lands during the call turns the accepted proposal into a stored rejection", async () => {
  const reason = "speaker merged or named more confidently during the call";
  await inRollback(async (tx) => {
    const { s, roster, window } = await seed(tx);
    // The roster was read before the call; the tracker merges S2 away while the model is thinking.
    await speakers.markMerged(tx, s.id, "S2", "S1");
    const llm = fakeLlm(answer([{ speaker_id: "S2", name: "Cathie Wood", role: null, confidence: 0.93, quote: "Joining us now is Cathie Wood of Ark Invest." }]));
    const result = await runNaming({ db: tx, llm: llm.client, sessionId: s.id, prompt, floor: 0.7 }, window, roster);
    expect(result.proposals.map((p) => [p.speaker_id, p.status, p.reason, p.quote_verified])).toEqual([["S2", "rejected", reason, true]]);
    expect(result.named).toEqual([]);
    expect(await names.forCall(tx, result.call.id)).toEqual(result.proposals);
    expect((await speakers.get(tx, s.id, "S2"))?.name).toBeNull();
  });
  await inRollback(async (tx) => {
    const { s, roster, window } = await seed(tx);
    // An earlier call only supplies a call id for the stronger name S2 inherits while the next call runs.
    const prior = await runNaming({ db: tx, llm: fakeLlm(answer([])).client, sessionId: s.id, prompt, floor: 0.7 }, window, roster);
    await speakers.setName(tx, s.id, "S2", { name: "Cathie Wood", role: "guest", confidence: 0.97, quote: "I'm Cathie Wood", callId: prior.call.id });
    const llm = fakeLlm(answer([{ speaker_id: "S2", name: "Tom", role: null, confidence: 0.8, quote: "Thanks for having me, Tom." }]));
    const result = await runNaming({ db: tx, llm: llm.client, sessionId: s.id, prompt, floor: 0.7 }, window, roster);
    expect(result.proposals.map((p) => [p.status, p.reason])).toEqual([["rejected", reason]]);
    expect(result.named).toEqual([]);
    expect(await speakers.get(tx, s.id, "S2")).toMatchObject({ name: "Cathie Wood", name_confidence: 0.97 });
  });
});
