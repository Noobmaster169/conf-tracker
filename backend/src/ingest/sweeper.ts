import type { LlmClient } from "../agents/llm-client";
import { ExtractConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import type { Hub } from "../realtime/hub";
import * as calls from "../repositories/calls";
import * as spans from "../repositories/spans";
import { type Extractor, extractorFactory } from "./extractor";
import { createGapFiller } from "./gap-filler";
import type { SessionRunner } from "./session-runner";
import { summaryAllowed } from "./summary-allowance";
import type { Summarize } from "./summarizer";

const log = childLogger({ module: "sweeper" });

/** Videos older than this are history: the sweeper does not go back for them. */
const SCAN_DAYS = 7;
/** A video whose latest extract call failed is left alone this long. */
const EXTRACT_BACKOFF_MS = 15 * 60 * 1000;

export interface SweepReport {
  extracted: string[];
  summarised: number[];
  /** Gaps that advanced a stage of their fill. */
  gaps: number[];
}

/** A segment of video `s` inside one of its open gaps: the gap filler's to extract, not the video's own extractor's. */
const IN_OPEN_GAP = `exists (select 1 from session_gaps sg where sg.session_id = g.session_id and sg.filled_at is null and g.t1 > sg.t0 and g.t0 < sg.t1)`;

/**
 * True when video `s` has lines its own extraction has not reached: the end of its last line (outside open gaps) is past
 * its furthest answered extract window.
 */
const OWES_EXTRACTION = `coalesce((select max((w->>'t1')::float8) from jsonb_array_elements((select words from segments g where g.session_id = s.id and not ${IN_OPEN_GAP} order by t1 desc limit 1)) w),
                       (select max(t1) from segments g where g.session_id = s.id and not ${IN_OPEN_GAP}), 0)
            > coalesce((select max(window_t1) from llm_calls where session_id = s.id and step = 'extract' and error is null), 0)`;

export interface SweeperDeps {
  db: Queryable;
  hub: Hub;
  llm: LlmClient;
  summarize: Summarize;
  runner: SessionRunner;
  config?: ExtractConfig;
  /** The clock, in ms; injected by tests. */
  now?: () => number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Finishes what the live loops left behind: the extract windows a stopped video still owes (a model that was down
 * when the stream ended) and the summaries of talks that ended without one. Never touches a video the runner is
 * using, and never runs twice at once.
 */
export function createSweeper(deps: SweeperDeps): { sweep(): Promise<SweepReport>; gapLegSettled(): Promise<void> } {
  const { db, hub, llm, summarize, runner } = deps;
  const factory = extractorFactory(llm);
  let running = false;

  const now = deps.now ?? Date.now;
  const filler = createGapFiller({ db, hub, llm, summarize, runner, config: deps.config, now });

  async function extractBacklogs(report: SweepReport): Promise<void> {
    // A finished video drops out: its cursor reaches the end of its last line. A failing one waits out its back-off.
    const { rows } = await db.query<{ id: string; config: Record<string, unknown> }>(
      `select s.id, s.config from sessions s
        where s.created_at > now() - make_interval(days => $1::int)
          and ${OWES_EXTRACTION}
          and not exists (select 1 from (select error, created_at from llm_calls where session_id = s.id and step = 'extract' order by id desc limit 1) l
                           where l.error is not null and l.created_at > $2::timestamptz)
        order by s.created_at`,
      [SCAN_DAYS, new Date(now() - EXTRACT_BACKOFF_MS)],
    );
    for (const { id, config } of rows) {
      // Re-checked per video: a resume may have claimed it while an earlier video was draining.
      if (runner.busy().includes(id)) continue;
      const work = (async () => {
        try {
          const before = await calls.lastAnsweredWindow(db, id, "extract");
          const extractor = factory({ db, hub, sessionId: id, config: { ...config, ...(deps.config ?? {}) }, resumeAt: before }) as Extractor | null;
          if (!extractor) return;
          try {
            // Yields at the next window once a start or resume of the video waits for this drain.
            await extractor.drain(() => !runner.wanted(id));
          } finally {
            extractor.stop();
          }
          if ((await calls.lastAnsweredWindow(db, id, "extract")) > before) report.extracted.push(id);
        } catch (error) {
          log.error({ sessionId: id, err: errorText(error) }, "sweeping a video's extraction failed");
        }
      })();
      runner.hold(id, work);
      await work;
    }
  }

  /**
   * Stopped videos with gaps still to try, once their own extraction owes nothing (or they do not extract): the gaps'
   * windows must lie below the video's extract cursor, never ahead of lines it still owes. Not held: only a gap leg
   * is (by the runner), and the filler checks before every step that the video is still stopped and free.
   */
  async function fillAllGaps(report: SweepReport): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `select s.id from sessions s
        where s.created_at > now() - make_interval(days => $1::int) and s.status = 'stopped'
          and exists (select 1 from session_gaps sg where sg.session_id = s.id and sg.filled_at is null and sg.note is null)
          and (coalesce(s.config->>'extract', 'true') = 'false' or not (${OWES_EXTRACTION}))
        order by s.created_at`,
      [SCAN_DAYS],
    );
    for (const { id } of rows) {
      if (runner.busy().includes(id)) continue;
      try {
        report.gaps.push(...(await filler.advance(id)));
      } catch (error) {
        log.error({ sessionId: id, err: errorText(error) }, "filling a video's gaps failed");
      }
    }
  }

  async function summariseTalks(report: SweepReport): Promise<void> {
    for (const { sessionId, talkId } of await spans.unsummarised(db, SCAN_DAYS)) {
      // A closed talk of a live video is summarised now, not once the video stops: the summary allowance already limits
      // how often. Only a video something else is settling on (a final loop run, a hold) waits.
      if (runner.pending().includes(sessionId)) continue;
      const work = (async () => {
        try {
          if (!(await summaryAllowed(db, sessionId, talkId, now()))) return;
          if (await summarize(sessionId, talkId)) report.summarised.push(talkId);
        } catch (error) {
          log.error({ sessionId, talkId, err: errorText(error) }, "sweeping a talk's summary failed");
        }
      })();
      runner.hold(sessionId, work);
      await work;
    }
  }

  return {
    async sweep() {
      const report: SweepReport = { extracted: [], summarised: [], gaps: [] };
      if (running) return report;
      running = true;
      try {
        await extractBacklogs(report);
        // After the backlogs, so a gap is filled only behind a finished extraction; before the summaries, which it may redo.
        await fillAllGaps(report);
        await summariseTalks(report);
      } catch (error) {
        log.error({ err: errorText(error) }, "sweep failed");
      } finally {
        running = false;
      }
      return report;
    },
    gapLegSettled: () => filler.legSettled(),
  };
}
