import type { Gap, SpeechEvent } from "../contracts";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import type { Hub } from "../realtime/hub";
import * as legs from "../repositories/legs";
import { speakerFloor } from "../repositories/resume";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import * as speakers from "../repositories/speakers";
import { createSpeakerTracker } from "./speaker-tracker";
import type { SpeechConnector, SpeechLink } from "./speech-client";

const log = childLogger({ module: "gap-leg" });

/** A leg's start this far from the gap's start means the recording could not be read from there. */
const START_TOLERANCE_S = 1;
const DEFAULT_MAX_SPEED = 3;

export interface GapLegDeps {
  db: Queryable;
  hub: Hub;
  connect: SpeechConnector;
  /** Stores one event of the leg in the video's event log, numbered after the video's own. */
  append(sessionId: string, event: SpeechEvent): Promise<void>;
  /** How long the leg may run before it counts as failed; by default twice the gap plus ten minutes. */
  timeoutMs?: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The speech session id of a gap's leg: one per gap, so a retry reuses it and two gaps never share one. */
export const gapSpeechId = (gap: Gap) => `${gap.session_id}-g${gap.id}`;

/** What is stored inside a gap: nothing but a previous try's leftovers, cleared before a new try. Nothing outside it. */
async function clearInside(db: Queryable, sessionId: string, t0: number, t1: number): Promise<void> {
  await db.query("delete from segments where session_id = $1 and t1 > $2 and t0 < $3", [sessionId, t0, t1]);
  await db.query(
    "delete from turns where session_id = $1 and window_id in (select id from diar_windows where session_id = $1 and t1 > $2 and t0 < $3)",
    [sessionId, t0, t1],
  );
  await db.query("delete from diar_windows where session_id = $1 and t1 > $2 and t0 < $3", [sessionId, t0, t1]);
}

/**
 * Transcribes a gap from the video's recording on a leg of its own (kind `gap`): speech reads from t0 and stops at t1,
 * with the video's voice labels. Its segments, diarization and speakers are stored on the video like any leg's, but it
 * never touches the video's status. True when speech read the whole stretch: it ended `source_ended` having started
 * within a second of t0. Anything else (a late start, an error, a refusal, a timeout) is false; the caller retries.
 */
export async function runGapLeg(deps: GapLegDeps, gap: Gap): Promise<boolean> {
  const { db, hub, connect } = deps;
  const sessionId = gap.session_id;
  const session = await sessions.get(db, sessionId);
  if (!session?.source_url) return false;
  await clearInside(db, sessionId, gap.t0, gap.t1);
  const floor = await speakerFloor(db, sessionId);
  let over = false;
  const tracker = createSpeakerTracker({ db, hub, sessionId, live: () => !over });
  tracker.seedTalk(await speakers.list(db, sessionId));
  const row = await legs.open(db, sessionId, { speechId: gapSpeechId(gap), kind: "gap", requestedT: gap.t0 });
  const maxSpeed = session.config.catchup_max_speed;

  let startAt: number | null = null;
  let lastT = gap.t0;
  let link: SpeechLink | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolve!: (filled: boolean) => void;
  const outcome = new Promise<boolean>((r) => (resolve = r));

  async function finish(reason: string, filled: boolean): Promise<void> {
    if (over) return;
    over = true;
    if (timer) clearTimeout(timer);
    link?.close();
    try {
      await legs.ended(db, row.id, { endT: lastT, reason });
    } catch (error) {
      log.error({ sessionId, gapId: gap.id, err: errorText(error) }, "ending a gap leg's row failed");
    }
    resolve(filled);
  }

  async function handle(event: SpeechEvent): Promise<void> {
    if (over) return;
    try {
      await deps.append(sessionId, event);
      if (over) return;
      switch (event.type) {
        case "session.started":
          startAt = event.start_at;
          lastT = Math.max(lastT, event.start_at);
          await legs.started(db, row.id, event.start_at);
          return;
        case "asr.segment": {
          const words = tracker.assign(event.words);
          const stored = await segments.insert(db, sessionId, { t0: event.t0, t1: event.t1, text: event.text, words });
          lastT = Math.max(lastT, stored.t1);
          hub.publish(sessionId, { type: "segment", data: stored });
          return;
        }
        case "diar.turns":
          await tracker.onTurns(event);
          return;
        case "speaker.new":
          await tracker.onNew(event);
          return;
        case "speaker.merged":
          await tracker.onMerged(event);
          return;
        case "health":
          // The video's health is its main leg's; a gap leg's would only confuse the page.
          return;
        case "session.ended": {
          const filled = event.reason === "source_ended" && startAt !== null && Math.abs(startAt - gap.t0) <= START_TOLERANCE_S;
          if (!filled) log.warn({ sessionId, gapId: gap.id, reason: event.reason, startAt, message: event.message }, "a gap leg did not read its whole stretch");
          await finish(event.reason, filled);
          return;
        }
      }
    } catch (error) {
      // Something it read was not stored: the stretch is not filled; the next try clears and reads it again.
      log.error({ sessionId, gapId: gap.id, err: errorText(error) }, "storing a gap leg's event failed");
      await finish("error", false);
    }
  }

  const timeoutMs = deps.timeoutMs ?? (gap.t1 - gap.t0) * 2000 + 10 * 60 * 1000;
  timer = setTimeout(() => void finish("timeout", false), timeoutMs);
  timer.unref?.();
  try {
    link = await connect(
      {
        session_id: gapSpeechId(gap),
        url: session.source_url,
        config: session.config,
        start_at: gap.t0,
        stop_at: gap.t1,
        registry_from: sessionId,
        speaker_floor: floor,
        record: false,
        max_speed: typeof maxSpeed === "number" && maxSpeed > 0 ? maxSpeed : DEFAULT_MAX_SPEED,
      },
      { onEvent: handle, onClose: (reason) => finish(`speech closed the socket: ${reason}`, false) },
    );
    // Over while the socket was opening (a timeout): nobody else will close it.
    if (over) link.close();
  } catch (error) {
    log.warn({ sessionId, gapId: gap.id, err: errorText(error) }, "speech refused a gap leg");
    await finish("error", false);
  }
  return outcome;
}
