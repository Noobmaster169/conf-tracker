import type { PoolClient } from "pg";
import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { TrackConfig } from "../src/contracts";
import { closePool } from "../src/db";
import { retrackRange } from "../src/pipeline/retrack";
import { createHub } from "../src/realtime/hub";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";
const say = (db: PoolClient, sessionId: string, t0: number, text = `w${t0}`) =>
  segments.insert(db, sessionId, { t0, t1: t0 + 5, text, words: [{ w: text, t0, t1: t0 + 5, p: 1, speaker_id: "S1" }] });

async function staged(db: PoolClient) {
  const stage = await stages.create(db, { conference: "Summit", name: "Main", day: "2026-11-16", description: "" });
  const mk = (title: string) => talks.create(db, stage.id, { title, description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [] });
  const [a, b, c] = [await mk("A"), await mk("B"), await mk("C")];
  const s = await sessions.create(db, { sourceUrl: URL, sourceFile: null, config: {}, stageId: stage.id });
  for (let t = 0; t < 1200; t += 20) await say(db, s.id, t, t === 400 ? "welcome to talk B everyone" : `w${t}`);
  const span = (talkId: number, t: number) => spans.switchTo(db, s.id, { talkId, state: "talk", t, confidence: 0.9, quote: null, source: "tracker", callId: null });
  await span(a.id, 0);
  await span(c.id, 600);
  await spans.close(db, s.id, 1200);
  return { s, a, b, c };
}

const shape = async (db: PoolClient, sessionId: string) =>
  (await spans.list(db, sessionId)).map((x) => ({ talk: x.talk_id, t0: x.t0, t1: x.t1, source: x.source }));

test("retrack splits the span over the gap when a talk started inside it, and the talks either side keep their outer ends", async () => {
  await inRollback(async (tx) => {
    const { s, a, b, c } = await staged(tx);
    const llm = fakeLlm(JSON.stringify({ state: "talk", talk_id: b.id, confidence: 0.9, quote: "welcome to talk B" }));
    await retrackRange({ db: tx, hub: createHub(100), sessionId: s.id, llm: llm.client, config: TrackConfig.parse({}) }, 300, 500);
    expect(await shape(tx, s.id)).toEqual([
      { talk: a.id, t0: 0, t1: 400, source: "tracker" },
      { talk: b.id, t0: 400, t1: 500, source: "tracker" },
      { talk: a.id, t0: 500, t1: 600, source: "tracker" },
      { talk: c.id, t0: 600, t1: 1200, source: "tracker" },
    ]);
    // The reads cover the gap's lines and nothing after it.
    expect(llm.requests.length).toBeGreaterThan(0);
    for (const r of llm.requests) expect(r.user).not.toMatch(/w5\d\d/);
  });
});

test("retrack that finds nothing new leaves the spans alone", async () => {
  await inRollback(async (tx) => {
    const { s } = await staged(tx);
    const before = await shape(tx, s.id);
    const llm = fakeLlm(JSON.stringify({ state: "unknown", talk_id: null, confidence: 0.1, quote: "" }));
    await retrackRange({ db: tx, hub: createHub(100), sessionId: s.id, llm: llm.client, config: TrackConfig.parse({}) }, 300, 500);
    expect(await shape(tx, s.id)).toEqual(before);
  });
});

test("rewriteRange trims the spans that reach into the range and drops the ones inside it", async () => {
  await inRollback(async (tx) => {
    const { s, a, b, c } = await staged(tx);
    await spans.switchTo(tx, s.id, { talkId: b.id, state: "talk", t: 1300, confidence: 0.9, quote: null, source: "admin", callId: null });
    await spans.rewriteRange(tx, s.id, 550, 1250, [{ talkId: null, state: "break", t0: 550, t1: 1250 }]);
    expect(await shape(tx, s.id)).toEqual([
      { talk: a.id, t0: 0, t1: 550, source: "tracker" },
      { talk: null, t0: 550, t1: 1250, source: "tracker" },
      { talk: b.id, t0: 1300, t1: null, source: "admin" },
    ]);
    expect(c.id).toBeGreaterThan(0);
  });
});
