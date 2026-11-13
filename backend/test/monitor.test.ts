import request from "supertest";
import { afterAll, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { createApp } from "../src/app";
import { ExtractConfig } from "../src/contracts";
import { closePool, type Queryable } from "../src/db";
import { createExtractor } from "../src/ingest/extractor";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const auth = { authorization: "Bearer test-key" };
const noRunner: SessionRunner = { start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => [], busy: () => [], hold: () => {}, fillGap: () => Promise.resolve(false), pending: () => [], wanted: () => false };

/** A stage on `day` with one talk, a video of it, and one claim said in it. */
async function stageWithClaim(db: Queryable, name: string, day: string, said: string) {
  const hub = createHub(100);
  const stage = await stages.create(db, { conference: "Monitor Conf", name, day, description: "" });
  const talk = await talks.create(db, stage.id, { title: `${name} keynote`, description: "", kind: "keynote", starts_at: null, ends_at: null, speakers: [] });
  const session = await sessions.create(db, { sourceUrl: "https://www.youtube.com/watch?v=QB5BNdBFujE", sourceFile: null, config: {}, stageId: stage.id, title: `${name} day` });
  await spans.switchTo(db, session.id, { talkId: talk.id, state: "talk", t: 0, confidence: 0.9, quote: null, source: "tracker", callId: null });
  await segments.insert(db, session.id, { t0: 5, t1: 10, text: said, words: said.split(" ").map((w, i) => ({ w, t0: 5 + i * 0.1, t1: 5.1 + i * 0.1, p: 1, speaker_id: "S1" })) });
  const llm = fakeLlm(JSON.stringify({ claims: [{ claim: said, kind: "opinion", importance: 3, topics: [], polarity: "neutral", quote: said }] }));
  await createExtractor({ db, hub, sessionId: session.id, llm: llm.client, config: ExtractConfig.parse({}) }).tick();
  return { hub, stage, talk, session };
}

test("the feed narrows to a day and a stage, and a video card carries its last talk and newest picture", async () => {
  await inRollback(async (tx) => {
    const main = await stageWithClaim(tx, "Main", "2031-01-02", "main stage says rates will fall");
    const side = await stageWithClaim(tx, "Side", "2031-01-02", "side stage says fees will rise");
    const other = await stageWithClaim(tx, "Main", "2031-01-03", "next day says volume doubles");
    // Two pictures of the main stage and a newer hidden one: the card shows the newest one not hidden.
    for (const [t, hidden] of [[10, false], [20, false], [30, true]] as const) {
      await tx.query("insert into frames (session_id, t, key, thumb_key, width, height, sig, motion, hidden) values ($1, $2, $3, $4, 1280, 720, '\\x00', '\\x00', $5)", [
        main.session.id, t, `frames/${main.session.id}/${t}.webp`, `thumbs/${main.session.id}/${t}.webp`, hidden,
      ]);
    }
    const app = createApp({ db: tx, hub: main.hub, runner: noRunner, frameUrl: (key) => `https://pub.example/${key}` });
    const get = (path: string) => request(app).get(path).set(auth);
    const claims = async (path: string) => ((await get(path)).body.items as { claim: string }[]).map((c) => c.claim).sort();

    expect(await claims("/feed?day=2031-01-02")).toEqual(["main stage says rates will fall", "side stage says fees will rise"]);
    expect(await claims(`/feed?day=2031-01-02&stage=${side.stage.id}`)).toEqual(["side stage says fees will rise"]);
    expect(await claims("/feed?day=2031-01-03")).toEqual(["next day says volume doubles"]);
    expect((await get("/feed?day=not-a-day")).status).toBe(400);

    const cards = (await get("/videos")).body as { session: { id: string }; last_talk: unknown; frame: unknown }[];
    const card = (id: string) => cards.find((c) => c.session.id === id)!;
    expect(card(main.session.id).last_talk).toEqual({ id: main.talk.id, title: "Main keynote" });
    expect(card(main.session.id).frame).toMatchObject({ t: 20, url: `https://pub.example/frames/${main.session.id}/20.webp`, thumb_url: `https://pub.example/thumbs/${main.session.id}/20.webp` });
    expect(card(other.session.id).frame).toBeNull();
  });
});
