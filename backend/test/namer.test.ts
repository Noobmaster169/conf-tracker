import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { type LiveEvent, NameConfig } from "../src/contracts";
import { closePool } from "../src/db";
import { createNamer, namerFactory } from "../src/ingest/namer";
import { createHub } from "../src/realtime/hub";
import * as calls from "../src/repositories/calls";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const config = NameConfig.parse({ name_window_s: 180 });
const say = (db: Parameters<typeof segments.insert>[0], sessionId: string, t0: number, text: string, speaker: string) =>
  segments.insert(db, sessionId, {
    t0,
    t1: t0 + 4,
    text,
    words: text.split(" ").map((w, i) => ({ w, t0: t0 + i * 0.5, t1: t0 + i * 0.5 + 0.4, p: 1, speaker_id: speaker })),
  });
const cathie = JSON.stringify({ proposals: [{ speaker_id: "S2", name: "Cathie Wood", role: "guest", confidence: 0.93, quote: "I'm Cathie Wood" }] });

test("a tick names who the window names, publishing the call and the renamed speaker", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const seen: LiveEvent[] = [];
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    hub.subscribe(s.id, (e) => seen.push(e));
    await speakers.upsert(tx, s.id, { speakerId: "S2", firstSeenT: 0, lastSeenT: 4 });
    await say(tx, s.id, 0, "I'm Cathie Wood", "S2");
    const llm = fakeLlm(cathie);
    await createNamer({ db: tx, hub, sessionId: s.id, llm: llm.client, config }).tick();
    expect(seen.map((e) => e.type)).toEqual(["call", "speaker"]);
    expect(seen[1]?.type === "speaker" && seen[1].data).toMatchObject({ speaker_id: "S2", name: "Cathie Wood" });
    expect(llm.requests[0]?.model).toBe("sonnet");
  });
});

test("the namer makes no call when everyone in the window is named, and none twice for the same window", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await speakers.upsert(tx, s.id, { speakerId: "S2", firstSeenT: 0, lastSeenT: 4 });
    await say(tx, s.id, 0, "nothing to go on", "S2");
    const llm = fakeLlm(JSON.stringify({ proposals: [] }));
    const namer = createNamer({ db: tx, hub, sessionId: s.id, llm: llm.client, config });
    await namer.tick();
    await namer.tick();
    expect(llm.requests).toHaveLength(1);

    await say(tx, s.id, 10, "I'm Cathie Wood", "S2");
    const call = await calls.insert(tx, s.id, {
      step: "name", promptVersion: "v1", model: "haiku", windowT0: 0, windowT1: 14, attempt: 1, input: "x", output: null, parsed: null,
      inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: null,
    });
    await speakers.setName(tx, s.id, "S2", { name: "Cathie Wood", role: null, confidence: 0.95, quote: "I'm Cathie Wood", callId: call.id });
    await namer.tick();
    expect(llm.requests).toHaveLength(1);
  });
});

test("a failed naming call is tried again on the next tick, and the factory honours name: false", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await speakers.upsert(tx, s.id, { speakerId: "S2", firstSeenT: 0, lastSeenT: 4 });
    await say(tx, s.id, 0, "I'm Cathie Wood", "S2");
    const llm = fakeLlm([new Error("llm-proxy unreachable"), cathie]);
    const namer = createNamer({ db: tx, hub, sessionId: s.id, llm: llm.client, config });
    await namer.tick();
    await namer.tick();
    expect(llm.requests).toHaveLength(2);
    expect((await speakers.get(tx, s.id, "S2"))?.name).toBe("Cathie Wood");
    expect(namerFactory(llm.client)({ db: tx, hub, sessionId: s.id, config: { name: false } })).toBeNull();
    expect(() => namerFactory(llm.client)({ db: tx, hub, sessionId: s.id, config: { name_floor: 2 } })).toThrow();
  });
});

test("a stream-time run only names from lines that ended by its boundary", async () => {
  await inRollback(async (tx) => {
    const hub = createHub(100);
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await speakers.upsert(tx, s.id, { speakerId: "S2", firstSeenT: 0, lastSeenT: 4 });
    await say(tx, s.id, 0, "I'm Cathie Wood", "S2"); // ends at 4
    const llm = fakeLlm(cathie);
    const namer = createNamer({ db: tx, hub, sessionId: s.id, llm: llm.client, config });
    await namer.tick(3);
    expect(llm.requests).toHaveLength(0);
    await namer.tick(4);
    expect(llm.requests[0]?.user).toContain("I'm Cathie Wood");
  });
});
