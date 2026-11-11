import type { LlmClient } from "../agents/llm-client";
import { ExtractConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import type { Hub } from "../realtime/hub";
import * as calls from "../repositories/calls";
import * as spans from "../repositories/spans";
import { type Extractor, extractorFactory } from "./extractor";
import type { SessionRunner } from "./session-runner";
import type { Summarize } from "./summarizer";

const log = childLogger({ module: "sweeper" });

/** Videos older than this are history: the sweeper does not go back for them. */
const SCAN_DAYS = 7;
/** A video whose latest extract call failed is left alone this long. */
const EXTRACT_BACKOFF_MS = 15 * 60 * 1000;
/** One summarize model call per talk and video in this time, and none after MAX_SUMMARY_FAILS failed ones. */
const SUMMARY_BACKOFF_MS = 60 * 60 * 1000;
const MAX_SUMMARY_FAILS = 5;

export interface SweepReport {
  extracted: string[];
  summarised: number[];
}

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
export function createSweeper(deps: SweeperDeps): { sweep(): Promise<SweepReport> } {
  const { db, hub, llm, summarize, runner } = deps;
  const factory = extractorFactory(llm);
  let running = false;

  const now = deps.now ?? Date.now;

  async function extractBacklogs(report: SweepReport): Promise<void> {
    // A finished video drops out: its cursor reaches the end of its last line. A failing one waits out its back-off.
    const { rows } = await db.query<{ id: string; config: Record<string, unknown> }>(
      `select s.id, s.config from sessions s
        where s.created_at > now() - make_interval(days => $1::int)
          and coalesce((select max((w->>'t1')::float8) from jsonb_array_elements((select words from segments where session_id = s.id order by t1 desc limit 1)) w),
                       (select max(t1) from segments where session_id = s.id), 0)
            > coalesce((select max(window_t1) from llm_calls where session_id = s.id and step = 'extract' and error is null), 0)
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
            await extractor.drain();
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

  /** At most one model call per talk an hour, and none once it has failed MAX_SUMMARY_FAILS times. */
  async function summaryAllowed(sessionId: string, talkId: number): Promise<boolean> {
    const { rows } = await db.query<{ fails: string; last: Date | null }>(
      `select count(*) filter (where error is not null) as fails, max(created_at) as last
         from llm_calls where session_id = $1 and step = 'summarize' and talk_id = $2`,
      [sessionId, talkId],
    );
    const row = rows[0];
    if (!row) return true;
    if (Number(row.fails) >= MAX_SUMMARY_FAILS) return false;
    return !row.last || row.last.getTime() <= now() - SUMMARY_BACKOFF_MS;
  }

  async function summariseTalks(report: SweepReport): Promise<void> {
    for (const { sessionId, talkId } of await spans.unsummarised(db, SCAN_DAYS)) {
      if (runner.busy().includes(sessionId)) continue;
      const work = (async () => {
        try {
          if (!(await summaryAllowed(sessionId, talkId))) return;
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
      const report: SweepReport = { extracted: [], summarised: [] };
      if (running) return report;
      running = true;
      try {
        await extractBacklogs(report);
        await summariseTalks(report);
      } catch (error) {
        log.error({ err: errorText(error) }, "sweep failed");
      } finally {
        running = false;
      }
      return report;
    },
  };
}
