import type { LlmClient } from "../agents/llm-client";
import { loadPrompt } from "../agents/prompts/registry";
import { runTracking } from "../agents/track";
import { type Span, TrackConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import { segmentsToLines } from "../pipeline/lines";
import { labelMap, resolveId } from "../pipeline/naming";
import { decide, type Read, renderTrackInput } from "../pipeline/tracking";
import type { Hub } from "../realtime/hub";
import * as people from "../repositories/people";
import * as segments from "../repositories/segments";
import * as spans from "../repositories/spans";
import * as speakers from "../repositories/speakers";
import { createLoop, type Loop, type LoopFactory } from "./loop";
import { loadStageContext } from "./stage-context";
import type { Summarize } from "./summarizer";

const log = childLogger({ module: "tracker" });

// A segment can start before the window's first line and still end inside it; this covers the longest chunk.
const SEGMENT_MARGIN_S = 30;

export interface TrackerDeps {
  db: Queryable;
  hub: Hub;
  sessionId: string;
  llm: LlmClient;
  config: TrackConfig;
  summarize?: Summarize;
}

/**
 * The attention layer. One per live video: every interval of stream time the model reads the last few minutes against
 * the stage's schedule and says what is on stage; the belief changes only as pipeline/tracking.ts allows. A video with
 * no stage, or a stage with no schedule, makes no calls.
 */
export function createTracker(deps: TrackerDeps): Loop {
  const { db, hub, sessionId, llm, config, summarize } = deps;
  const prompt = { ...loadPrompt("track", config.track_prompt), model: config.track_model };
  let pending: Read | null = null;
  // Boundaries that pass with no new speech would each ask about the same window again; one answer per window.
  let answeredT1: number | null = null;
  const writing = new Set<Promise<unknown>>();

  const publish = (span: Span | null): void => {
    if (span) hub.publish(sessionId, { type: "span", data: span });
  };

  /** A talk that just left the stage gets its summary; detached, so the next read is not held up by it. */
  function summarise(closed: Span | null): void {
    if (!summarize || closed?.state !== "talk" || closed.talk_id === null) return;
    const job = summarize(sessionId, closed.talk_id).finally(() => writing.delete(job));
    writing.add(job);
  }

  async function run(upTo: number): Promise<void> {
    try {
      const last = await segments.lastUpTo(db, sessionId, upTo);
      if (!last || last.t1 === answeredT1) return;
      const context = await loadStageContext(db, sessionId);
      if (!context || context.schedule.length === 0) return;
      const roster = await speakers.list(db, sessionId);
      const from = Math.max(0, last.t1 - config.track_window_s - SEGMENT_MARGIN_S);
      const recent = (await segments.list(db, sessionId, { from, to: last.t1 })).filter((s) => s.t1 <= upTo);
      const lines = segmentsToLines(recent)
        .filter((l) => l.t1 > last.t1 - config.track_window_s)
        .map((l) => (l.speaker_id === null ? l : { ...l, speaker_id: resolveId(roster, l.speaker_id) }));
      if (lines.length === 0) return;
      const seen = new Set((await spans.list(db, sessionId)).flatMap((s) => (s.talk_id === null || s.t1 === null ? [] : [s.talk_id])));
      const names = labelMap(roster, await people.forSession(db, sessionId));
      const input = renderTrackInput({ stage: context.stage, schedule: context.schedule, running: context.running, seen, lines, names, now: last.t1 });
      const result = await runTracking({ db, llm, sessionId, prompt }, input, lines, context.schedule);
      hub.publish(sessionId, { type: "call", data: result.call });
      if (!result.read) return;
      answeredT1 = last.t1;
      // The belief is read again: an admin correction may have landed while the model was answering, and it wins.
      const running = await spans.open(db, sessionId);
      const decision = decide(running, pending, result.read, config.track_switch_confidence);
      if (decision.kind === "keep") {
        pending = decision.pending;
        return;
      }
      pending = null;
      const { closed, opened } = await spans.switchTo(db, sessionId, {
        talkId: decision.talkId, state: decision.state, t: decision.t, confidence: decision.confidence, quote: result.quote, source: "tracker", callId: result.call.id,
      });
      publish(closed);
      publish(opened);
      summarise(closed);
    } catch (error) {
      log.error({ sessionId, err: error instanceof Error ? error.message : String(error) }, "tracking tick failed");
    }
  }

  const loop = createLoop(run, { intervalS: config.track_interval_s, finalRun: false });
  return {
    ...loop,
    // The video is over: whatever was on stage ends where the transcript does, and gets its summary too.
    async flush() {
      await loop.flush();
      try {
        const end = (await segments.lastUpTo(db, sessionId, Number.POSITIVE_INFINITY))?.t1;
        const closed = end === undefined ? null : await spans.close(db, sessionId, end);
        publish(closed);
        summarise(closed);
        await Promise.all(writing);
      } catch (error) {
        log.error({ sessionId, err: error instanceof Error ? error.message : String(error) }, "closing the timeline failed");
      }
    },
  };
}

/** Reads the video's tracker settings; null means this video does not track. Throws on a bad config or an unknown prompt version. */
export function trackerFactory(llm: LlmClient, summarize?: Summarize): LoopFactory {
  return ({ db, hub, sessionId, config }) => {
    const parsed = TrackConfig.parse(config);
    if (!parsed.track) return null;
    return createTracker({ db, hub, sessionId, llm, config: parsed, summarize });
  };
}
