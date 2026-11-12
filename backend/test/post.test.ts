import request from "supertest";
import { afterAll, describe, expect, test } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { PostOutput, rankClaims, renderPostInput, withFooter } from "../src/agents/post";
import { createApp } from "../src/app";
import type { FeedItem } from "../src/contracts-views";
import type { TalkSummary } from "../src/contracts";
import { closePool, type Queryable } from "../src/db";
import { createPoster, withPost } from "../src/ingest/poster";
import { createHub } from "../src/realtime/hub";
import type { SessionRunner } from "../src/ingest/session-runner";
import * as calls from "../src/repositories/calls";
import * as claims from "../src/repositories/claims";
import * as posts from "../src/repositories/posts";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as stages from "../src/repositories/stages";
import * as summaries from "../src/repositories/summaries";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const auth = { authorization: "Bearer test-key" };
const noRunner: SessionRunner = { start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => [], busy: () => [], hold: () => {}, fillGap: () => Promise.resolve(false), pending: () => [], wanted: () => false };

const POST = [
  "🔴 Just wrapped: Fireside Chat with Anatoly Yakovenko at Accelerate USA",
  "",
  "• Solana Mobile has sold 150K+ phones, with ~$8B in transactions on them",
  '• App store fees of 20–30% "don\'t really work" for financial apps',
  "• Each new phone takes 18–24 months to build",
].join("\n");
const FOOTER = "Real-time Breakpoint Alpha streamed at: https://breakpoint.fiber.ag";

const call = (db: Queryable, sessionId: string, step: string) =>
  calls.insert(db, sessionId, {
    step, promptVersion: "v1", model: "opus", windowT0: 0, windowT1: 600, attempt: 1, input: "x", output: "x", parsed: null,
    inputTokens: null, outputTokens: null, costUsd: null, latencyMs: 1, error: null,
  });

async function setUp(db: Queryable, config: Record<string, unknown> = {}) {
  const stage = await stages.create(db, { conference: "Accelerate USA", name: "Main stage", day: "2026-11-10", description: "" });
  const talk = await talks.create(db, stage.id, {
    title: "Fireside Chat: Anatoly Yakovenko", description: "", kind: "fireside", starts_at: "10:00", ends_at: "10:30",
    speakers: [{ name: "Anatoly Yakovenko", org: "Solana Labs", title: "Co-Founder", role: "speaker" }, { name: "Alejandra Martinez", org: "Foundation Capital", title: "Partner", role: "moderator" }],
  });
  const session = await sessions.create(db, { sourceUrl: "https://www.youtube.com/watch?v=QB5BNdBFujE", sourceFile: null, config, stageId: stage.id, title: "Day 1" });
  await spans.switchTo(db, session.id, { talkId: talk.id, state: "talk", t: 100, confidence: 1, quote: null, source: "admin", callId: null });
  await spans.close(db, session.id, 700);
  const extract = await call(db, session.id, "extract");
  const claim = { speakerId: null, t1: null, topics: [], polarity: "neutral" as const, quote: "q", quoteVerified: true, status: "ok" as const };
  await claims.insertMany(db, session.id, extract.id, [
    { ...claim, t0: 200, claim: "Solana Mobile has sold over 150,000 units.", kind: "metric", importance: 3 },
    { ...claim, t0: 150, claim: "Smartphones are the final interface.", kind: "opinion", importance: 2 },
    { ...claim, t0: 900, claim: "Said after the talk ended.", kind: "fact", importance: 5 },
  ]);
  return { stage, talk, session };
}

const summarise = async (db: Queryable, talkId: number, sessionId: string) => {
  const written = await call(db, sessionId, "summarize");
  return summaries.insert(db, { talkId, sessionId, callId: written.id, summary: { headline: "Yakovenko on phones", content: "# Yakovenko on phones\n\nHe said \"don't really work\"." } });
};

describe("the post's answer", () => {
  test("takes a header and bullets, and refuses links, missing bullets and more than three emoji", () => {
    expect(PostOutput.safeParse({ post: POST }).success).toBe(true);
    const issues = (post: string) => {
      const parsed = PostOutput.safeParse({ post });
      return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    };
    expect(issues("🔴 Just wrapped: x\n\nno bullets here")).toEqual(['the highlights must be at least two lines starting with "• "']);
    expect(issues(`${POST}\n\n${FOOTER}`)).toEqual(["no links: the line with the stream's link is added under the post for you"]);
    expect(issues(`${POST}\n• 📱 phones 💸 money 🤖 bots`)[0]).toContain("at most 3 emoji");
    expect(issues("• a\n• b")[0]).toContain("the first line must be the header");
  });

  test("gets the footer after a blank line, and none when the footer is empty", () => {
    expect(withFooter(`${POST}\n`, FOOTER)).toBe(`${POST}\n\n${FOOTER}`);
    expect(withFooter(POST, "  ")).toBe(POST);
  });

  test("is asked with the session, its claims most important first, and the write-up", async () => {
    await inRollback(async (tx) => {
      const { stage, talk } = await setUp(tx);
      const item = (claim: string, importance: number | null, t0: number) => ({ claim, importance, t0, kind: "fact", person: null, speaker_name: "Anatoly" }) as unknown as FeedItem;
      const ranked = rankClaims([item("a", 2, 10), item("b", 4, 50), item("c", null, 5), item("d", 4, 20)]);
      expect(ranked.map((c) => c.claim)).toEqual(["d", "b", "a", "c"]);
      const input = renderPostInput({ stage, talk, claims: [item("small", 1, 1), item("big", 4, 2)], summary: "# The article" });
      expect(input).toContain('Conference: Accelerate USA\nStage: Accelerate USA, Main stage\nSession: "Fireside Chat: Anatoly Yakovenko" (fireside)');
      expect(input).toContain("On stage: Anatoly Yakovenko (Co-Founder, Solana Labs); Alejandra Martinez (Partner, Foundation Capital) [moderator]");
      expect(input).toContain("Claims (2, most important first):\n- [importance 4, fact] big (Anatoly)\n- [importance 1, fact] small (Anatoly)");
      expect(input).toContain("Write-up:\n# The article");
    });
  });
});

describe("the Poster", () => {
  test("writes a talk's post from its summary and the claims said during it, footer added, the call on the talk", async () => {
    await inRollback(async (tx) => {
      const { talk, session } = await setUp(tx);
      const llm = fakeLlm(JSON.stringify({ post: POST }));
      const post = createPoster({ db: tx, llm: llm.client });
      // No summary yet: nothing to write from.
      expect(await post(session.id, talk.id)).toBeNull();
      expect(llm.requests).toHaveLength(0);

      await summarise(tx, talk.id, session.id);
      const written = await post(session.id, talk.id);
      expect(written?.text).toBe(`${POST}\n\n${FOOTER}`);
      expect(await posts.latest(tx, talk.id)).toEqual(written);
      const request = llm.requests[0]!;
      expect(request.model).toBe("opus");
      expect(request.system).toContain("🔴 Just wrapped");
      expect(request.user).toContain("Solana Mobile has sold over 150,000 units.");
      expect(request.user).toContain("Smartphones are the final interface.");
      expect(request.user).not.toContain("Said after the talk ended.");
      expect(request.user).toContain('He said "don\'t really work".');
      const { rows } = await tx.query<{ step: string; talk_id: string; window_t0: number; window_t1: number }>("select step, talk_id, window_t0, window_t1 from llm_calls where step = 'post' and session_id = $1", [session.id]);
      expect(rows).toEqual([{ step: "post", talk_id: String(talk.id), window_t0: 100, window_t1: 700 }]);
    });
  });

  test("a bad answer is shown its mistake once; a second bad one stores nothing", async () => {
    await inRollback(async (tx) => {
      const { talk, session } = await setUp(tx);
      await summarise(tx, talk.id, session.id);
      const llm = fakeLlm([JSON.stringify({ post: "🔴 x\n• only one" }), JSON.stringify({ post: "🔴 x\n• still one" })]);
      expect(await createPoster({ db: tx, llm: llm.client })(session.id, talk.id)).toBeNull();
      expect(llm.requests[1]!.user).toContain('the highlights must be at least two lines starting with "• "');
      expect(await posts.latest(tx, talk.id)).toBeNull();
    });
  });

  test("follows its settings: a footer of the video's own, and off unless forced", async () => {
    await inRollback(async (tx) => {
      const { talk, session } = await setUp(tx, { post: false, post_footer: "Live at example.com", post_model: "sonnet" });
      await summarise(tx, talk.id, session.id);
      const llm = fakeLlm(JSON.stringify({ post: POST }));
      const post = createPoster({ db: tx, llm: llm.client });
      expect(await post(session.id, talk.id)).toBeNull();
      expect((await post(session.id, talk.id, { force: true }))?.text).toBe(`${POST}\n\nLive at example.com`);
      expect(llm.requests[0]!.model).toBe("sonnet");
    });
  });

  test("comes after every summary written, and never after one that was not", async () => {
    const asked: number[] = [];
    const post = async (_s: string, talkId: number) => {
      asked.push(talkId);
      return null;
    };
    const summary = { id: 1 } as TalkSummary;
    const wrapped = withPost(async (_s, talkId) => (talkId === 1 ? summary : null), post);
    expect(await wrapped("s", 1)).toBe(summary);
    expect(await wrapped("s", 2)).toBeNull();
    expect(asked).toEqual([1]);
  });

  test("owes a post for every summary newer than its last post, and the session page and admin route show and write it", async () => {
    await inRollback(async (tx) => {
      const { talk, session } = await setUp(tx);
      expect(await posts.unposted(tx)).toEqual([]);
      await summarise(tx, talk.id, session.id);
      expect(await posts.unposted(tx)).toEqual([{ sessionId: session.id, talkId: talk.id }]);

      const llm = fakeLlm(JSON.stringify({ post: POST }));
      const post = createPoster({ db: tx, llm: llm.client });
      const app = createApp({ db: tx, hub: createHub(10), runner: noRunner, post });
      expect((await request(app).get(`/talks/${talk.id}`).set(auth)).body.post).toBeNull();
      const written = await request(app).post(`/talks/${talk.id}/post`).set(auth);
      expect(written.status).toBe(201);
      expect(written.body.text).toBe(`${POST}\n\n${FOOTER}`);
      expect((await request(app).get(`/talks/${talk.id}`).set(auth)).body.post).toMatchObject({ talk_id: talk.id, text: `${POST}\n\n${FOOTER}` });
      expect(await posts.unposted(tx)).toEqual([]);
      expect((await request(app).post("/talks/999999999/post").set(auth)).status).toBe(404);
    });
  });
});
