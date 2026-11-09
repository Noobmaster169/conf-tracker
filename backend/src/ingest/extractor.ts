import { runExtraction } from "../agents/extract";
import type { LlmClient } from "../agents/llm-client";
import { loadPrompt } from "../agents/prompts/registry";
import { ExtractConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import { segmentsToLines } from "../pipeline/lines";
import { nameMap } from "../pipeline/naming";
import { selectWindow } from "../pipeline/window";
import type { Hub } from "../realtime/hub";
import * as claims from "../repositories/claims";
import * as segments from "../repositories/segments";
import * as speakers from "../repositories/speakers";
import { createLoop, type Loop, type LoopFactory } from "./loop";

const log = childLogger({ module: "extractor" });

// A segment can start before the window's first line and still end inside it; this covers the longest chunk.
const SEGMENT_MARGIN_S = 30;

/** Kept as names so phase 3 imports still read naturally. */
export type Extractor = Loop;
export type ExtractorFactory = LoopFactory;

export interface ExtractorDeps {
  db: Queryable;
  hub: Hub;
  sessionId: string;
  llm: LlmClient;
  config: ExtractConfig;
}

/** One per live session: every interval of stream time, the lines since the cursor go to the model, and the cursor moves only on a call that answered. */
export function createExtractor(deps: ExtractorDeps): Extractor {
  const { db, hub, sessionId, llm, config } = deps;
  const prompt = { ...loadPrompt("extract", config.extract_prompt), model: config.extract_model };
  let cursorT = 0;

  async function run(upTo: number): Promise<void> {
    try {
      const from = Math.max(0, cursorT - config.context_tail_s - SEGMENT_MARGIN_S);
      const to = Number.isFinite(upTo) ? upTo : undefined;
      // A line that ends after the boundary belongs to the next run, as it would have live.
      const upToNow = (await segments.list(db, sessionId, { from, to })).filter((s) => s.t1 <= upTo);
      const window = selectWindow(segmentsToLines(upToNow), cursorT, config);
      if (!window) return;
      const prior = await claims.latest(db, sessionId, config.dedupe_n);
      const names = nameMap(await speakers.list(db, sessionId));
      const result = await runExtraction({ db, llm, sessionId, prompt }, window, prior, names);
      hub.publish(sessionId, { type: "call", data: result.call });
      if (result.claims.length > 0) hub.publish(sessionId, { type: "claims.new", data: result.claims });
      if (result.call.error === null) cursorT = window.t1;
    } catch (error) {
      log.error({ sessionId, err: error instanceof Error ? error.message : String(error) }, "extraction tick failed");
    }
  }

  // The final run extracts the tail said since the last tick, so a stop loses nothing.
  return createLoop(run, { intervalS: config.extract_interval_s, finalRun: true });
}

/** Reads the session's extraction settings; null means this session does not extract. Throws on a bad config or an unknown prompt version. */
export function extractorFactory(llm: LlmClient): ExtractorFactory {
  return ({ db, hub, sessionId, config }) => {
    const parsed = ExtractConfig.parse(config);
    if (!parsed.extract) return null;
    return createExtractor({ db, hub, sessionId, llm, config: parsed });
  };
}
