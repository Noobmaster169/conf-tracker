import type { LlmClient } from "../agents/llm-client";
import { runNaming } from "../agents/name";
import { loadPrompt } from "../agents/prompts/registry";
import { NameConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import { segmentsToLines } from "../pipeline/lines";
import { selectNameWindow } from "../pipeline/naming";
import { matchPerson, splitRole } from "../pipeline/people-match";
import type { Hub } from "../realtime/hub";
import * as people from "../repositories/people";
import * as segments from "../repositories/segments";
import * as speakers from "../repositories/speakers";
import { liveConfig, livePrompt } from "./live-config";
import { createLoop, type Loop, type LoopFactory } from "./loop";
import { loadStageContext, scheduledPeople } from "./stage-context";

const log = childLogger({ module: "namer" });

// A segment can start before the window's first line and still end inside it; this covers the longest chunk.
const SEGMENT_MARGIN_S = 30;

export interface NamerDeps {
  db: Queryable;
  hub: Hub;
  sessionId: string;
  llm: LlmClient;
  config: NameConfig;
}

/** One per live session: every interval of stream time, when someone in the last few minutes has no name, the model is asked who they are. */
export function createNamer(deps: NamerDeps): Loop {
  const { db, hub, sessionId, llm } = deps;
  // Loaded here too, so a missing prompt version refuses the session before anything starts.
  const initialPrompt = { ...loadPrompt("name", deps.config.name_prompt), model: deps.config.name_model };
  // Boundaries that pass with no new speech would each ask about the same window again; one answer per window.
  let answeredT1: number | null = null;

  async function run(upTo: number): Promise<void> {
    try {
      const last = await segments.lastUpTo(db, sessionId, upTo);
      if (!last) return;
      const config = await liveConfig(db, sessionId, NameConfig, deps.config);
      const prompt = livePrompt("name", config.name_prompt, config.name_model, initialPrompt);
      const from = Math.max(0, last.t1 - config.name_window_s - SEGMENT_MARGIN_S);
      const roster = await speakers.list(db, sessionId);
      const recent = (await segments.list(db, sessionId, { from, to: last.t1 })).filter((s) => s.t1 <= upTo);
      const window = selectNameWindow(segmentsToLines(recent), roster, config);
      if (!window || window.t1 === answeredT1) return;
      const context = await loadStageContext(db, sessionId, window.t1);
      const scheduled = context ? scheduledPeople(context) : [];
      const result = await runNaming({ db, llm, sessionId, prompt, floor: config.name_floor }, window, roster, scheduled.map((s) => s.line), scheduled.map((s) => s.person.name));
      hub.publish(sessionId, { type: "call", data: result.call });
      for (const speaker of result.named) {
        // A named voice becomes a person: one the schedule expects when the name fits exactly one of them, otherwise
        // whoever already goes by that name, or someone new. The label takes the person's spelling.
        const known = speaker.name === null ? null : matchPerson(speaker.name, scheduled.map((s) => s.person));
        const person = known ?? (speaker.name === null ? null : await people.upsertByName(db, { name: speaker.name, ...splitRole(speaker.role) }));
        const linked = person ? await speakers.setPerson(db, sessionId, speaker.speaker_id, person) : null;
        if (person) hub.publish(sessionId, { type: "person", data: person });
        hub.publish(sessionId, { type: "speaker", data: linked ?? speaker });
      }
      if (result.call.error === null) answeredT1 = window.t1;
    } catch (error) {
      log.error({ sessionId, err: error instanceof Error ? error.message : String(error) }, "naming tick failed");
    }
  }

  // No final run: a name found after the stop would help nobody, and it would cost a call.
  // Only the newest window is worth naming: a replay faster than the model would otherwise name voices minutes late.
  return createLoop(run, { intervalS: deps.config.name_interval_s, finalRun: false, latestOnly: true });
}

/** Reads the session's naming settings; null means this session does not name. Throws on a bad config or an unknown prompt version. */
export function namerFactory(llm: LlmClient): LoopFactory {
  return ({ db, hub, sessionId, config }) => {
    const parsed = NameConfig.parse(config);
    if (!parsed.name) return null;
    return createNamer({ db, hub, sessionId, llm, config: parsed });
  };
}
