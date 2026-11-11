import type { LlmClient } from "../agents/llm-client";
import { ExtractConfig, type Gap, NameConfig, TrackConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import { retrackRange } from "../pipeline/retrack";
import type { Hub } from "../realtime/hub";
import * as gaps from "../repositories/gaps";
import * as sessions from "../repositories/sessions";
import * as spans from "../repositories/spans";
import { extractRange } from "./extractor";
import { gapSpeechId } from "./gap-leg";
import { createNameRun } from "./namer";
import type { SessionRunner } from "./session-runner";
import { summaryAllowed } from "./summary-allowance";
import type { Summarize } from "./summarizer";

const log = childLogger({ module: "gap-filler" });

/** Failed gap legs after which a gap is given up and noted for the admin page. */
const MAX_GAP_TRIES = 5;
/** One naming run per this much of a filled gap, over its newest window. */
const NAME_EVERY_S = 180;

export interface GapFillerDeps {
  db: Queryable;
  hub: Hub;
  llm: LlmClient;
  summarize: Summarize;
  runner: SessionRunner;
  /** Overrides on the video's extraction settings (tests). */
  config?: Record<string, unknown>;
  now?: () => number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The gap's legs that ended: whether one read the whole stretch, and how many did not. */
async function legHistory(db: Queryable, gap: Gap): Promise<{ read: boolean; failed: number; lastReason: string | null }> {
  const { rows } = await db.query<{ filled: boolean; end_reason: string | null }>(
    `select (end_reason = 'source_ended' and start_t is not null and abs(start_t - $3) <= 1) as filled, end_reason
       from session_legs where session_id = $1 and kind = 'gap' and speech_id = $2 and ended_at is not null order by id`,
    [gap.session_id, gapSpeechId(gap), gap.t0],
  );
  const failed = rows.filter((r) => !r.filled);
  return { read: rows.some((r) => r.filled), failed: failed.length, lastReason: failed.at(-1)?.end_reason ?? null };
}

/**
 * Fills the open gaps of a stopped video, earliest first: each is transcribed from the recording, then the steps go
 * back for it (the tracker rewrites the spans over it, the namer names its voices, the extractor extracts its lines,
 * the talks it touches are summarised again) and it is marked filled. A step that fails leaves the gap open for the
 * next sweep, which picks up where this one stopped: a stretch already read is not read again. Returns the gaps filled.
 *
 * The caller holds the video (runner.hold) and calls this only once the video's own extraction owes nothing outside
 * its open gaps, so the gaps' windows always lie below the video's extract cursor.
 */
export async function fillGaps(deps: GapFillerDeps, sessionId: string): Promise<number> {
  const { db, runner } = deps;
  const session = await sessions.get(db, sessionId);
  if (!session || session.status !== "stopped") return 0;
  let filled = 0;
  for (const gap of await gaps.open(db, sessionId)) {
    if (gap.note !== null) continue;
    if (!session.source_url) {
      await gaps.note(db, gap.id, "this video has no recording to read the stretch from");
      continue;
    }
    let history = await legHistory(db, gap);
    if (!history.read) {
      if (history.failed < MAX_GAP_TRIES && (await runner.fillGap(sessionId, gap))) {
        history = { ...history, read: true };
      } else {
        history = await legHistory(db, gap);
        if (history.failed >= MAX_GAP_TRIES) {
          await gaps.note(db, gap.id, `the recording could not be read for this stretch after ${history.failed} tries (last: ${history.lastReason ?? "unknown"})`);
        }
        continue;
      }
    }
    try {
      if (await catchUp(deps, gap)) {
        await gaps.filled(db, gap.id);
        filled += 1;
      } else {
        // The model is failing: the later gaps would fail the same way. The next sweep carries on.
        break;
      }
    } catch (error) {
      log.error({ sessionId, gapId: gap.id, err: errorText(error) }, "catching up a filled gap failed");
      break;
    }
  }
  return filled;
}

/** Everything after the transcript for one read gap. True once its extraction is done. */
async function catchUp(deps: GapFillerDeps, gap: Gap): Promise<boolean> {
  const { db, hub, llm, summarize } = deps;
  const sessionId = gap.session_id;
  const session = await sessions.get(db, sessionId);
  if (!session) return false;
  const config = { ...session.config, ...(deps.config ?? {}) };

  await retrackRange({ db, hub, sessionId, llm, config: TrackConfig.parse(config) }, gap.t0, gap.t1);

  const names = NameConfig.parse(config);
  if (names.name) {
    const run = createNameRun({ db, hub, sessionId, llm, config: names });
    for (let end = Math.min(gap.t0 + NAME_EVERY_S, gap.t1); ; end = Math.min(end + NAME_EVERY_S, gap.t1)) {
      await run(end);
      if (end >= gap.t1) break;
    }
  }

  if (!(await extractRange({ db, hub, sessionId, llm, config: ExtractConfig.parse(config) }, gap.t0, gap.t1))) return false;

  const now = deps.now ?? Date.now;
  const touched = new Set<number>();
  for (const span of await spans.list(db, sessionId)) {
    if (span.state === "talk" && span.talk_id !== null && span.t0 < gap.t1 && (span.t1 === null || span.t1 > gap.t0)) touched.add(span.talk_id);
  }
  for (const talkId of touched) {
    try {
      if (await summaryAllowed(db, sessionId, talkId, now(), { failuresOnly: true })) await summarize(sessionId, talkId, { force: false });
    } catch (error) {
      log.error({ sessionId, talkId, err: errorText(error) }, "summarising a talk again after a gap failed");
    }
  }
  return true;
}
