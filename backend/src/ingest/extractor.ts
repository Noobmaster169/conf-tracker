import { runExtraction } from "../agents/extract";
import type { LlmClient } from "../agents/llm-client";
import { loadPrompt } from "../agents/prompts/registry";
import { ExtractConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import { segmentsToLines } from "../pipeline/lines";
import { labelMap } from "../pipeline/naming";
import { selectWindow } from "../pipeline/window";
import type { Hub } from "../realtime/hub";
import * as calls from "../repositories/calls";
import * as claims from "../repositories/claims";
import * as people from "../repositories/people";
import * as segments from "../repositories/segments";
import * as speakers from "../repositories/speakers";
import { liveConfig, livePrompt } from "./live-config";
import { createLoop, type Loop, type LoopFactory } from "./loop";
import { loadStageContext, onStageText } from "./stage-context";

const log = childLogger({ module: "extractor" });

// A segment can start before the window's first line and still end inside it; this covers the longest chunk.
const SEGMENT_MARGIN_S = 30;

export interface Extractor extends Loop {
  /** Extracts window after window from the cursor, one call at a time on the loop's queue: true once no window is left, false at the first call that fails (the cursor stays). */
  drain(): Promise<boolean>;
}
/** Kept as a name so phase 3 imports still read naturally. */
export type ExtractorFactory = LoopFactory;

export interface ExtractorDeps {
  db: Queryable;
  hub: Hub;
  sessionId: string;
  llm: LlmClient;
  config: ExtractConfig;
  /** The stored progress the video resumes from: the first stream-time boundary is the one after it. */
  resumeAt?: number;
}

type Outcome = "none" | "answered" | "failed";

/**
 * One per live video: every interval of stream time, the next window from the cursor goes to the model, and the cursor
 * moves only on a call that answered. The cursor is the stored progress (the furthest answered extract window), read
 * once before the first run, so a new extractor for the same video carries on where the last one stopped and never skips.
 */
export function createExtractor(deps: ExtractorDeps): Extractor {
  const { db, hub, sessionId, llm } = deps;
  // Loaded here too, so a missing prompt version refuses the session before anything starts.
  const initialPrompt = { ...loadPrompt("extract", deps.config.extract_prompt), model: deps.config.extract_model };
  let cursorT: number | null = null;

  async function extractOnce(upTo: number): Promise<Outcome> {
    cursorT ??= await calls.lastAnsweredWindow(db, sessionId, "extract");
    const config = await liveConfig(db, sessionId, ExtractConfig, deps.config);
    const prompt = livePrompt("extract", config.extract_prompt, config.extract_model, initialPrompt);
    const from = Math.max(0, cursorT - config.context_tail_s - SEGMENT_MARGIN_S);
    const to = Number.isFinite(upTo) ? upTo : undefined;
    // A line that ends after the boundary belongs to the next run, as it would have live.
    const upToNow = (await segments.list(db, sessionId, { from, to })).filter((s) => s.t1 <= upTo);
    const window = selectWindow(segmentsToLines(upToNow), cursorT, config);
    if (!window) return "none";
    const prior = await claims.latest(db, sessionId, config.dedupe_n);
    const names = labelMap(await speakers.list(db, sessionId), await people.forSession(db, sessionId));
    // The schedule's view of the stage, when the video has one: who "we" is, and what the session is about.
    const context = await loadStageContext(db, sessionId, window.t1);
    const result = await runExtraction({ db, llm, sessionId, prompt }, window, prior, names, context ? onStageText(context) : null);
    hub.publish(sessionId, { type: "call", data: result.call });
    if (result.claims.length > 0) hub.publish(sessionId, { type: "claims.new", data: result.claims });
    if (result.call.error !== null) return "failed";
    cursorT = window.t1;
    return "answered";
  }

  async function attempt(upTo: number): Promise<Outcome> {
    try {
      return await extractOnce(upTo);
    } catch (error) {
      log.error({ sessionId, err: error instanceof Error ? error.message : String(error) }, "extraction tick failed");
      return "failed";
    }
  }

  // A tick runs one window; the cursor never jumps, so a backlog is worked off a window per tick, in order.
  const loop = createLoop(async (upTo) => void (await attempt(upTo)), {
    intervalS: deps.config.extract_interval_s,
    finalRun: false,
    startAfter: deps.resumeAt ?? 0,
  });

  async function drain(): Promise<boolean> {
    let done = false;
    // One job on the loop's queue, so no tick's call runs alongside the drain's.
    await loop.enqueue(async (live) => {
      for (;;) {
        if (!live()) return;
        const outcome = await attempt(Number.POSITIVE_INFINITY);
        if (outcome === "failed") return;
        if (outcome === "none") {
          done = true;
          return;
        }
      }
    });
    return done;
  }

  return {
    ...loop,
    drain,
    // The final pass drains everything said since the cursor, so a stop loses nothing the model can answer.
    async flush() {
      await loop.flush();
      await drain();
    },
  };
}

/** Reads the session's extraction settings; null means this session does not extract. Throws on a bad config or an unknown prompt version. */
export function extractorFactory(llm: LlmClient): ExtractorFactory {
  return ({ db, hub, sessionId, config, resumeAt }) => {
    const parsed = ExtractConfig.parse(config);
    if (!parsed.extract) return null;
    return createExtractor({ db, hub, sessionId, llm, config: parsed, resumeAt });
  };
}

/** How far either side of a window the claims it is deduped against may lie. */
const RANGE_DEDUPE_S = 300;

/**
 * Extracts a stretch the live extractor never saw (a filled gap): window after window from t0 until the lines end at
 * t1, by the same rules as live, each window deduped against the claims nearest to it rather than the latest ones. Its
 * cursor is its own (the answered windows ending inside the stretch), so it resumes after a failure, and it never reads
 * or moves the video's: its windows end at or before t1, below where the video's extraction already is. True when done.
 */
export async function extractRange(
  deps: Omit<ExtractorDeps, "resumeAt"> & { proceed?: () => Promise<boolean> },
  t0: number,
  t1: number,
): Promise<boolean> {
  const { db, hub, sessionId, llm } = deps;
  const config = await liveConfig(db, sessionId, ExtractConfig, deps.config);
  if (!config.extract) return true;
  const prompt = livePrompt("extract", config.extract_prompt, config.extract_model, { ...loadPrompt("extract", deps.config.extract_prompt), model: deps.config.extract_model });
  let cursorT = await calls.answeredWithin(db, sessionId, t0, t1);
  try {
    while (cursorT < t1) {
      const from = Math.max(0, cursorT - config.context_tail_s - SEGMENT_MARGIN_S);
      // Only the stretch's own lines are fresh: what ends after t1 belongs to the video's extraction, already done.
      const rows = (await segments.list(db, sessionId, { from, to: t1 })).filter((s) => s.t1 <= t1);
      const window = selectWindow(segmentsToLines(rows), cursorT, config);
      if (!window) return true;
      if (deps.proceed && !(await deps.proceed())) return false;
      // Its neighbours on both sides, the claims after the stretch included, nearest first.
      const prior = await claims.around(db, sessionId, window.t0, window.t1, RANGE_DEDUPE_S, config.dedupe_n);
      const names = labelMap(await speakers.list(db, sessionId), await people.forSession(db, sessionId));
      const context = await loadStageContext(db, sessionId, window.t1);
      const result = await runExtraction({ db, llm, sessionId, prompt }, window, prior, names, context ? onStageText(context) : null);
      hub.publish(sessionId, { type: "call", data: result.call });
      if (result.claims.length > 0) hub.publish(sessionId, { type: "claims.new", data: result.claims });
      if (result.call.error !== null) return false;
      cursorT = window.t1;
    }
    return true;
  } catch (error) {
    log.error({ sessionId, t0, t1, err: error instanceof Error ? error.message : String(error) }, "extracting a gap failed");
    return false;
  }
}
