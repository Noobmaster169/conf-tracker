import type { LlmClient } from "../agents/llm-client";
import { loadPrompt } from "../agents/prompts/registry";
import { runTracking } from "../agents/track";
import { type Span, TrackConfig } from "../contracts";
import type { Queryable } from "../db";
import { liveConfig, livePrompt } from "../ingest/live-config";
import { loadStageContext } from "../ingest/stage-context";
import type { Hub } from "../realtime/hub";
import * as people from "../repositories/people";
import * as segments from "../repositories/segments";
import * as spans from "../repositories/spans";
import * as speakers from "../repositories/speakers";
import { segmentsToLines } from "./lines";
import { labelMap, resolveId } from "./naming";
import { decide, type Read, renderTrackInput } from "./tracking";

// A segment can start before the window's first line and still end inside it; this covers the longest chunk.
const SEGMENT_MARGIN_S = 30;

export interface RetrackDeps {
  db: Queryable;
  hub: Hub;
  sessionId: string;
  llm: LlmClient;
  config: TrackConfig;
}

/**
 * Reads what was on stage over a stretch the live tracker never heard (a filled gap), with the same prompt and the same
 * hysteresis as live, starting from the span that covers t0. When the belief changed inside [t0, t1], the spans there
 * are rewritten; otherwise nothing is. A video with no stage, or no schedule, is left alone.
 */
export async function retrackRange(deps: RetrackDeps, t0: number, t1: number): Promise<void> {
  const { db, hub, sessionId, llm } = deps;
  const config = await liveConfig(db, sessionId, TrackConfig, deps.config);
  if (!config.track || t1 <= t0) return;
  const context = await loadStageContext(db, sessionId, t0);
  if (!context || context.schedule.length === 0) return;
  const prompt = livePrompt("track", config.track_prompt, config.track_model, { ...loadPrompt("track", deps.config.track_prompt), model: deps.config.track_model });
  const roster = await speakers.list(db, sessionId);
  const names = labelMap(roster, await people.forSession(db, sessionId));
  const stored = await spans.list(db, sessionId);

  // The belief as the reads move through the gap: the span covering t0, then each switch they make.
  const covering = context.running && (context.running.t1 === null || context.running.t1 > t0) ? context.running : null;
  let belief: Span | null = covering;
  let pending: Read | null = null;
  const switches: { talkId: number | null; state: "talk" | "break"; t: number }[] = [];
  const seen = new Set(stored.flatMap((s) => (s.talk_id !== null && s.t0 < t0 && s.talk_id !== covering?.talk_id ? [s.talk_id] : [])));

  for (let end = Math.min(t0 + config.track_window_s, t1); ; end = Math.min(end + config.track_window_s, t1)) {
    const from = Math.max(0, end - config.track_window_s - SEGMENT_MARGIN_S);
    const rows = (await segments.list(db, sessionId, { from, to: end })).filter((s) => s.t1 <= end);
    const lines = segmentsToLines(rows)
      .filter((l) => l.t1 > end - config.track_window_s)
      .map((l) => (l.speaker_id === null ? l : { ...l, speaker_id: resolveId(roster, l.speaker_id) }));
    if (lines.length > 0) {
      const input = renderTrackInput({ stage: context.stage, schedule: context.schedule, running: belief, seen, lines, names, now: end });
      const result = await runTracking({ db, llm, sessionId, prompt }, input, lines, context.schedule);
      hub.publish(sessionId, { type: "call", data: result.call });
      if (result.read) {
        const decision = decide(belief, pending, result.read, config.track_switch_confidence);
        if (decision.kind === "keep") {
          pending = decision.pending;
        } else {
          pending = null;
          // Evidence before the gap, or before the last switch, dates the change to where the reads can place it.
          const t = Math.min(t1, Math.max(t0, decision.t, switches.at(-1)?.t ?? t0));
          if (belief?.talk_id != null && belief.talk_id !== decision.talkId) seen.add(belief.talk_id);
          switches.push({ talkId: decision.talkId, state: decision.state, t });
          belief = { id: -1, session_id: sessionId, talk_id: decision.talkId, state: decision.state, t0: t, t1: null, confidence: decision.confidence, source: "tracker" };
        }
      }
    }
    if (end >= t1) break;
  }
  if (switches.length === 0) return;

  const edges = [...switches.map((s) => s.t), t1];
  const next: spans.RangeSpan[] = switches.map((s, i) => ({ talkId: s.talkId, state: s.state, t0: s.t, t1: edges[i + 1]! }));
  if (covering && switches[0]!.t > t0) next.unshift({ talkId: covering.talk_id, state: covering.state, t0, t1: switches[0]!.t });
  await spans.rewriteRange(db, sessionId, t0, t1, next);
  for (const span of (await spans.list(db, sessionId)).filter((s) => s.t0 < t1 + 1 && (s.t1 === null || s.t1 > t0 - 1))) {
    hub.publish(sessionId, { type: "span", data: span });
  }
}
