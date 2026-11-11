import type { LlmClient } from "../agents/llm-client";
import { ExtractConfig, type Gap, NameConfig, type Session, TrackConfig } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import type { Hub } from "../realtime/hub";
import * as gaps from "../repositories/gaps";
import * as sessions from "../repositories/sessions";
import * as spans from "../repositories/spans";
import { extractRange } from "./extractor";
import { createNameRun } from "./namer";
import { retrackRange } from "./retrack";
import type { SessionRunner } from "./session-runner";
import { summaryAllowance } from "./summary-allowance";
import type { Summarize } from "./summarizer";

const log = childLogger({ module: "gap-filler" });

/** A step that failed or was refused (a gap leg included) is tried again after this. */
const RETRY_MS = 15 * 60 * 1000;
/** A gap still not transcribed this long after its first try is given up and noted for the admin page. */
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** One naming run per this much of a filled gap, over its newest window. */
const NAME_EVERY_S = 180;

export interface GapFillerDeps {
  db: Queryable;
  hub: Hub;
  llm: LlmClient;
  summarize: Summarize;
  runner: SessionRunner;
  /** Overrides on the video's settings (tests). */
  config?: Record<string, unknown>;
  now?: () => number;
}

export interface GapFiller {
  /**
   * Takes the open gaps of a stopped video on from their stored stage, as far as each goes. A gap with no transcript
   * gets a gap leg, at most one at a time across all videos and not awaited: its end stores the outcome and the next
   * call carries on. Returns the ids of the gaps that advanced a stage.
   */
  advance(sessionId: string): Promise<number[]>;
  /** Resolves once the gap leg in flight, if any, has ended and its outcome is stored. */
  legSettled(): Promise<void>;
}

type Outcome = "done" | "failed" | "stopped";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Fills the gaps of stopped videos as a staged job: transcribed (a gap leg read the stretch from the recording), tracked
 * (the spans over it rewritten), named (its voices), extracted (its lines), summarised (the talks it touches, again),
 * then filled. Each stage is stored, so a later call continues where the last stopped and never redoes a stage. A
 * step that fails or is refused leaves the stage where it was and waits RETRY_MS. The fill stops between steps (and
 * before every model call) as soon as the video is started or resumed, and carries on once it is stopped again.
 *
 * The caller calls this only once the video's own extraction owes nothing outside its open gaps, so the gaps' windows
 * always lie below the video's extract cursor.
 */
export function createGapFiller(deps: GapFillerDeps): GapFiller {
  const { db, runner } = deps;
  const now = deps.now ?? Date.now;
  let leg: Promise<void> | null = null;

  /** The video is still stopped and nothing else is using it. */
  async function ours(sessionId: string): Promise<boolean> {
    if (runner.busy().includes(sessionId)) return false;
    return (await sessions.get(db, sessionId))?.status === "stopped";
  }

  function startLeg(gap: Gap): void {
    leg = (async () => {
      await gaps.startTrying(db, gap.id, new Date(now()));
      if (await runner.fillGap(gap.session_id, gap)) {
        await gaps.setStage(db, gap.id, "transcribed");
        return;
      }
      // Closed by a start or resume of the video (it is no longer stopped): not a failed try, so no back-off later.
      if ((await sessions.get(db, gap.session_id))?.status !== "stopped") return;
      await gaps.tried(db, gap.id, new Date(now()));
      const fresh = await gaps.get(db, gap.id);
      if (fresh?.since && Date.parse(fresh.since) <= now() - GIVE_UP_MS) {
        await gaps.note(db, gap.id, `the recording could not be read for this stretch since ${fresh.since.slice(0, 16).replace("T", " ")} UTC`);
      }
    })()
      .catch((error: unknown) => log.error({ sessionId: gap.session_id, gapId: gap.id, err: errorText(error) }, "a gap leg's outcome was not stored"))
      .finally(() => {
        leg = null;
      });
  }

  /** The talks a gap touches get their summary written again; done when each has one written since the gap was extracted. */
  async function summarise(gap: Gap): Promise<boolean> {
    const sessionId = gap.session_id;
    const touched = new Set<number>();
    for (const span of await spans.list(db, sessionId)) {
      if (span.state === "talk" && span.talk_id !== null && span.t0 < gap.t1 && (span.t1 === null || span.t1 > gap.t0)) touched.add(span.talk_id);
    }
    let all = true;
    for (const talkId of touched) {
      const { rows: written } = await db.query(
        "select 1 from talk_summaries where session_id = $1 and talk_id = $2 and created_at >= $3::timestamptz limit 1",
        [sessionId, talkId, gap.stage_at],
      );
      if (written.length > 0) continue;
      const allowance = await summaryAllowance(db, sessionId, talkId, now(), { failuresOnly: true });
      // Given up after five failures, as the sweeper gives up: holding the gap open would not bring it back.
      if (allowance === "given_up") continue;
      if (allowance === "wait" || !(await ours(sessionId))) {
        all = false;
        continue;
      }
      const { rows: before } = await db.query<{ id: string | null }>("select max(id) as id from llm_calls where session_id = $1", [sessionId]);
      if (await deps.summarize(sessionId, talkId, { force: false })) continue;
      // Null is also "nothing to summarise" (too short, summaries off): only a failed call keeps the step open.
      const { rows: failed } = await db.query(
        "select 1 from llm_calls where session_id = $1 and step = 'summarize' and talk_id = $2 and error is not null and id > $3 limit 1",
        [sessionId, talkId, before[0]?.id ?? 0],
      );
      if (failed.length > 0) all = false;
    }
    return all;
  }

  /** The model steps of one transcribed gap, from its stored stage. */
  async function steps(session: Session, start: Gap, advanced: number[]): Promise<Outcome> {
    const sessionId = session.id;
    const { hub, llm } = deps;
    const config = { ...session.config, ...(deps.config ?? {}) };
    const proceed = () => ours(sessionId);
    const stepped = async (stage: Parameters<typeof gaps.setStage>[2]) => {
      await gaps.setStage(db, start.id, stage);
      if (!advanced.includes(start.id)) advanced.push(start.id);
    };
    let gap = start;
    for (;;) {
      if (!(await proceed())) return "stopped";
      let ok: boolean;
      switch (gap.stage) {
        case "transcribed":
          ok = await retrackRange({ db, hub, sessionId, llm, config: TrackConfig.parse(config), proceed }, gap.t0, gap.t1);
          if (ok) await stepped("tracked");
          break;
        case "tracked": {
          ok = true;
          const names = NameConfig.parse(config);
          if (names.name) {
            const run = createNameRun({ db, hub, sessionId, llm, config: names });
            for (let end = Math.min(gap.t0 + NAME_EVERY_S, gap.t1); ok; end = Math.min(end + NAME_EVERY_S, gap.t1)) {
              ok = (await proceed()) && (await run(end));
              if (end >= gap.t1) break;
            }
          }
          if (ok) await stepped("named");
          break;
        }
        case "named":
          ok = await extractRange({ db, hub, sessionId, llm, config: ExtractConfig.parse(config), proceed }, gap.t0, gap.t1);
          if (ok) await stepped("extracted");
          break;
        case "extracted":
          ok = await summarise(gap);
          if (ok) await stepped("summarised");
          break;
        case "summarised":
          await gaps.filled(db, gap.id);
          return "done";
        default:
          return "failed";
      }
      if (!ok) return (await proceed()) ? "failed" : "stopped";
      gap = (await gaps.get(db, gap.id)) ?? gap;
    }
  }

  return {
    async advance(sessionId) {
      const advanced: number[] = [];
      const session = await sessions.get(db, sessionId);
      if (!session || session.status !== "stopped") return advanced;
      for (const gap of await gaps.open(db, sessionId)) {
        if (gap.note !== null) continue;
        if (!session.source_url) {
          await gaps.note(db, gap.id, "this video has no recording to read the stretch from");
          continue;
        }
        if (gap.tried_at && Date.parse(gap.tried_at) > now() - RETRY_MS) continue;
        if (gap.stage === null) {
          if (!leg && !runner.busy().includes(sessionId)) startLeg(gap);
          continue;
        }
        try {
          const outcome = await steps(session, gap, advanced);
          if (outcome === "stopped") break;
          if (outcome === "failed") await gaps.tried(db, gap.id, new Date(now()));
        } catch (error) {
          log.error({ sessionId, gapId: gap.id, err: errorText(error) }, "a step of a gap's fill failed");
          await gaps.tried(db, gap.id, new Date(now()));
        }
      }
      return advanced;
    },
    legSettled: () => leg ?? Promise.resolve(),
  };
}
