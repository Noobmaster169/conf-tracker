import type { LlmClient } from "../agents/llm-client";
import { runPost } from "../agents/post";
import { loadPrompt } from "../agents/prompts/registry";
import { PostConfig, type TalkPost } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import * as feed from "../repositories/feed";
import * as sessions from "../repositories/sessions";
import * as spans from "../repositories/spans";
import * as stages from "../repositories/stages";
import * as summaries from "../repositories/summaries";
import * as talks from "../repositories/talks";
import type { Summarize } from "./summarizer";

const log = childLogger({ module: "poster" });

/** Writes the X post of one talk as it was heard in one video. Null when it has no summary yet, posts are off, or the model failed. */
export type WritePost = (sessionId: string, talkId: number, opts?: { force?: boolean }) => Promise<TalkPost | null>;

/** The post is written from the talk's summary and claims, so it needs the summary first. `force` is the admin asking again, posts off or not. */
export function createPoster({ db, llm }: { db: Queryable; llm: LlmClient }): WritePost {
  return async (sessionId, talkId, opts = {}) => {
    try {
      const session = await sessions.get(db, sessionId);
      const talk = await talks.get(db, talkId);
      const stage = talk ? await stages.get(db, talk.stage_id) : null;
      if (!session || !talk || !stage) return null;
      const config = PostConfig.parse(session.config);
      if (!config.post && !opts.force) return null;
      const summary = await summaries.latestFor(db, talkId, sessionId);
      if (!summary) return null;
      const claims = await feed.ofTalkInVideo(db, sessionId, talkId);
      const stretches = await spans.forTalk(db, sessionId, talkId);
      const window = { t0: stretches[0]?.t0 ?? 0, t1: Math.max(...stretches.map((s) => s.t1 ?? s.t0), 0) };
      const prompt = { ...loadPrompt("post", config.post_prompt), model: config.post_model };
      return await runPost({ db, llm, sessionId, prompt }, { stage, talk, claims, summary: summary.summary.content, window, footer: config.post_footer });
    } catch (error) {
      log.error({ sessionId, talkId, err: error instanceof Error ? error.message : String(error) }, "post failed");
      return null;
    }
  };
}

/**
 * The summarizer, followed by the Poster whenever it wrote a summary: every way a summary gets written (a talk leaving
 * the stage, the sweep, a gap filled, the admin asking again) brings a fresh post with it. A post that fails never fails
 * the summary; the sweep writes it later.
 */
export function withPost(summarize: Summarize, post: WritePost): Summarize {
  return async (sessionId, talkId, opts = {}) => {
    const summary = await summarize(sessionId, talkId, opts);
    if (summary) await post(sessionId, talkId, { force: opts.force });
    return summary;
  };
}
