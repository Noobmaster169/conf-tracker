import type { LlmClient } from "../agents/llm-client";
import { loadPrompt } from "../agents/prompts/registry";
import { runSummary } from "../agents/summarize";
import { SummaryConfig, type TalkSummary } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import { segmentsToLines } from "../pipeline/lines";
import { labelMap } from "../pipeline/naming";
import * as people from "../repositories/people";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import * as spans from "../repositories/spans";
import * as speakers from "../repositories/speakers";
import * as stages from "../repositories/stages";
import * as talks from "../repositories/talks";

const log = childLogger({ module: "summarizer" });

// A segment can start before a span and still carry its first words.
const SEGMENT_MARGIN_S = 30;
const MAX_SEGMENTS = 20_000;

/** Writes the summary of one talk as it was heard in one video. Null when there is nothing to summarise or the model failed. */
export type Summarize = (sessionId: string, talkId: number, opts?: { force?: boolean }) => Promise<TalkSummary | null>;

/**
 * The summary is written from the transcript of every stretch the talk was on stage, once the talk is over. `force` is
 * the admin asking again: it skips the minimum length, not the need for a transcript.
 */
export function createSummarizer({ db, llm }: { db: Queryable; llm: LlmClient }): Summarize {
  return async (sessionId, talkId, opts = {}) => {
    try {
      const session = await sessions.get(db, sessionId);
      const talk = await talks.get(db, talkId);
      const stage = talk ? await stages.get(db, talk.stage_id) : null;
      if (!session || !talk || !stage) return null;
      const config = SummaryConfig.parse(session.config);
      if (!config.summarize && !opts.force) return null;
      const stretches = await spans.forTalk(db, sessionId, talkId);
      const end = (await segments.lastUpTo(db, sessionId, Number.POSITIVE_INFINITY))?.t1 ?? 0;
      const ranges = stretches.map((s) => ({ t0: s.t0, t1: s.t1 ?? end }));
      const heardS = ranges.reduce((n, r) => n + Math.max(0, r.t1 - r.t0), 0);
      if (ranges.length === 0 || (!opts.force && heardS < config.summary_min_s)) return null;
      const lines = [];
      for (const range of ranges) {
        const rows = await segments.list(db, sessionId, { from: Math.max(0, range.t0 - SEGMENT_MARGIN_S), to: range.t1, limit: MAX_SEGMENTS });
        lines.push(...segmentsToLines(rows).filter((line) => line.t0 >= range.t0 && line.t0 < range.t1));
      }
      if (lines.length === 0) return null;
      const names = labelMap(await speakers.list(db, sessionId), await people.forSession(db, sessionId));
      const prompt = { ...loadPrompt("summarize", config.summary_prompt), model: config.summary_model };
      return await runSummary({ db, llm, sessionId, prompt }, { stage, talk, lines, names });
    } catch (error) {
      log.error({ sessionId, talkId, err: error instanceof Error ? error.message : String(error) }, "summary failed");
      return null;
    }
  };
}
