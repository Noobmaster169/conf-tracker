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

  async function extractBacklogs(busy: Set<string>, report: SweepReport): Promise<void> {
    const { rows } = await db.query<{ id: string; config: Record<string, unknown> }>(
      `select s.id, s.config from sessions s
        where s.created_at > now() - make_interval(days => $1::int)
          and coalesce((select max(t1) from segments where session_id = s.id), 0)
            > coalesce((select max(window_t1) from llm_calls where session_id = s.id and step = 'extract' and error is null), 0)
        order by s.created_at`,
      [SCAN_DAYS],
    );
    for (const { id, config } of rows) {
      if (busy.has(id)) continue;
      try {
        const resumeAt = await calls.lastAnsweredWindow(db, id, "extract");
        const extractor = factory({ db, hub, sessionId: id, config: { ...config, ...(deps.config ?? {}) }, resumeAt }) as Extractor | null;
        if (!extractor) continue;
        try {
          if (await extractor.drain()) report.extracted.push(id);
        } finally {
          extractor.stop();
        }
      } catch (error) {
        log.error({ sessionId: id, err: errorText(error) }, "sweeping a video's extraction failed");
      }
    }
  }

  async function summariseTalks(busy: Set<string>, report: SweepReport): Promise<void> {
    for (const { sessionId, talkId } of await spans.unsummarised(db, SCAN_DAYS)) {
      if (busy.has(sessionId)) continue;
      try {
        if (await summarize(sessionId, talkId)) report.summarised.push(talkId);
      } catch (error) {
        log.error({ sessionId, talkId, err: errorText(error) }, "sweeping a talk's summary failed");
      }
    }
  }

  return {
    async sweep() {
      const report: SweepReport = { extracted: [], summarised: [] };
      if (running) return report;
      running = true;
      try {
        const busy = new Set(runner.busy());
        await extractBacklogs(busy, report);
        await summariseTalks(busy, report);
      } catch (error) {
        log.error({ err: errorText(error) }, "sweep failed");
      } finally {
        running = false;
      }
      return report;
    },
  };
}
