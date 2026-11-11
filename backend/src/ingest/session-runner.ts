import type { Session, SpeechEvent, StartMessage } from "../contracts";
import type { Queryable } from "../db";
import { TerminalError } from "../lib/errors";
import { childLogger } from "../lib/logger";
import type { Hub } from "../realtime/hub";
import * as events from "../repositories/events";
import * as gaps from "../repositories/gaps";
import * as legs from "../repositories/legs";
import { resumePoint, speakerFloor, truncateAfter } from "../repositories/resume";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import * as speakers from "../repositories/speakers";
import type { Loop, LoopFactory } from "./loop";
import { createSpeakerTracker, type SpeakerTracker } from "./speaker-tracker";
import type { SpeechConnector, SpeechLink } from "./speech-client";

const log = childLogger({ module: "session-runner" });

/** Seconds before the next leg after the nth failure in a row; the last value repeats forever. */
const BACKOFF_S = [5, 10, 20, 40, 60];
/** How long a video may stay recovering before it also asks for a person. */
const ATTENTION_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SPEED = 3;

export type Cancel = () => void;
export type SetTimer = (fn: () => void, ms: number) => Cancel;

export interface SessionRunner {
  start(sessionId: string): Promise<Session>;
  stop(sessionId: string): Promise<Session>;
  /** Feeds a degraded or stopped video again, from its resume point. */
  resume(sessionId: string): Promise<Session>;
  /** Feeds every video a previous process left running (starting, live, recovering); returns their ids. */
  resumeAll(): Promise<string[]>;
  live(): string[];
  /** Ids a sweep must leave alone: live ones, and ones whose final loop runs have not settled. */
  busy(): string[];
  /** Registers background work on a video (a sweep's drain): it counts as busy, and a start or resume waits for it before opening a leg. */
  hold(sessionId: string, work: Promise<unknown>): void;
}

/** One connection to speech for a video. `dead` once it failed, ended or was stopped: nothing from it counts after. */
interface LegState {
  rowId: number | null;
  rowEnded: boolean;
  requested: number;
  lastT: number;
  link: SpeechLink | null;
  tracker: SpeakerTracker;
  dead: boolean;
}

/**
 * A video this process feeds. It is in `videos` from its first leg until it ends or is stopped (`done`); meanwhile it
 * has exactly one of: a leg open or opening (`leg`), a retry scheduled (`retry`), or its first setup in flight.
 */
interface Video {
  id: string;
  loops: Loop[] | null;
  leg: LegState | null;
  retry: Cancel | null;
  attempt: number;
  lastError: string | null;
  recoveringSince: number | null;
  attention: string | null;
  done: boolean;
  first: Promise<Session> | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** Persist first, publish second: what the browser sees is always already stored. */
export function createSessionRunner(deps: {
  db: Queryable;
  hub: Hub;
  connect: SpeechConnector;
  loops?: LoopFactory[];
  now?: () => number;
  setTimer?: SetTimer;
}): SessionRunner {
  const { db, hub, connect } = deps;
  const factories = deps.loops ?? [];
  const now = deps.now ?? Date.now;
  const setTimer: SetTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });
  const videos = new Map<string, Video>();
  /** Final loop runs still going after a video was released, per id. */
  const flushing = new Map<string, Set<Promise<unknown>>>();
  /** Background work registered through hold(), per id. */
  const holds = new Map<string, Set<Promise<unknown>>>();
  const holdsSettled = async (id: string) => {
    while (holds.get(id)?.size) await Promise.allSettled([...holds.get(id)!]);
  };
  // Event numbering outlives a Video: after a stop and an instant resume, the old leg's append may still be in flight
  // with a number the database does not show yet, so the new Video continues after it instead of reusing it.
  const seqs = new Map<string, number>();

  const publishSession = (session: Session) => hub.publish(session.id, { type: "session", data: session });

  /** Another Video now holds this id (a stop, then a resume): the old one must not touch the row any more. */
  const replaced = (v: Video) => {
    const holder = videos.get(v.id);
    return holder !== undefined && holder !== v;
  };

  /**
   * Publishes a status write that may have landed after a stop; if so the stop wins and is written again, unless a
   * new Video already holds the id, whose status is then the row's and is left alone.
   */
  async function publishUnlessStopped(v: Video, session: Session): Promise<void> {
    if (replaced(v)) return;
    if (!v.done || session.status === "stopped") {
      publishSession(session);
      return;
    }
    const stopped = await sessions.setStatus(db, v.id, "stopped");
    if (!replaced(v)) publishSession(stopped);
  }

  /** A status write by a Video that is ending (degraded, stopped): skipped once a new Video holds the id. */
  async function writeFinalStatus(v: Video, status: "degraded" | "stopped"): Promise<void> {
    if (replaced(v)) return;
    const session = await sessions.setStatus(db, v.id, status);
    if (!replaced(v)) publishSession(session);
  }

  const forget = (v: Video) => {
    v.done = true;
    v.retry?.();
    v.retry = null;
    if (videos.get(v.id) === v) videos.delete(v.id);
  };

  // `cancel` is a user's stop: the stream-time runs a fast replay has queued are dropped, not paid for.
  const releaseLoops = (v: Video, opts: { cancel?: boolean } = {}) => {
    const own = v.loops ?? [];
    v.loops = [];
    for (const loop of own) {
      // A stop keeps only the run in flight and the final drain from the cursor (extractor only); an end drains the
      // whole queue, so a finished replay's claims keep arriving. Detached either way: a stop must not wait on a model.
      if (opts.cancel) loop.cancelQueued();
      const pending = loop
        .flush()
        .catch((error: unknown) => log.error({ sessionId: v.id, err: errorText(error) }, "final loop run failed"))
        .finally(() => {
          loop.stop();
          const set = flushing.get(v.id);
          set?.delete(pending);
          if (set?.size === 0) flushing.delete(v.id);
        });
      if (!flushing.has(v.id)) flushing.set(v.id, new Set());
      flushing.get(v.id)!.add(pending);
    }
  };

  /** Ends a leg's row once, whoever gets there first. */
  async function endLegRow(leg: LegState, reason: string): Promise<void> {
    if (leg.rowId === null || leg.rowEnded) return;
    leg.rowEnded = true;
    await legs.ended(db, leg.rowId, { endT: leg.lastT, reason });
  }

  const isCurrent = (v: Video, leg: LegState) => !v.done && v.leg === leg && !leg.dead;

  function startMessage(session: Session, r: number, floor: number): StartMessage {
    const speed = session.config.speed;
    const maxSpeed = session.config.catchup_max_speed;
    // A replay's url is kept for the page's embed; speech reads the stored recording instead.
    const replayOf = session.replay_of ?? undefined;
    return {
      session_id: session.id,
      url: replayOf ? undefined : (session.source_url ?? undefined),
      file: replayOf ? undefined : (session.source_file ?? undefined),
      replay_of: replayOf,
      speed: typeof speed === "number" ? speed : undefined,
      config: session.config,
      start_at: r,
      speaker_floor: floor,
      max_speed: typeof maxSpeed === "number" && maxSpeed > 0 ? maxSpeed : DEFAULT_MAX_SPEED,
    };
  }

  /**
   * Opens the video's next leg from its resume point. Does nothing if the video is done or already has a leg or a
   * retry. Every await is followed by a check that the leg is still the video's: a stop in between wins.
   * With `loud` (a fresh start), a failure to connect marks the video degraded and throws instead of retrying.
   */
  async function openLeg(v: Video, opts: { loud: boolean }): Promise<void> {
    if (v.done || v.leg || v.retry) return;
    const leg: LegState = {
      rowId: null,
      rowEnded: false,
      requested: 0,
      lastT: 0,
      link: null,
      // Its writes stop as soon as the leg is no longer the video's.
      tracker: createSpeakerTracker({ db, hub, sessionId: v.id, live: () => isCurrent(v, leg) }),
      dead: false,
    };
    v.leg = leg;
    const gone = () => !isCurrent(v, leg);

    let session: Session;
    let r: number;
    // Set for a missing row or a refused config: retrying cannot fix either. Any other error here is a database read.
    let terminal = false;
    try {
      const found = await sessions.get(db, v.id);
      if (!found) {
        terminal = true;
        throw new TerminalError(`session ${v.id} not found`);
      }
      session = found;
      if (gone()) return;
      r = await resumePoint(db, v.id);
      if (gone()) return;
      if (!seqs.has(v.id)) {
        // Numbering continues from storage. Read on every open until it succeeds once: a failed read must not leave
        // the video numbering from 1 into the stored events' keys.
        const stored = await events.maxSeq(db, v.id);
        // A Video replaced during the read must not reset a newer Video's numbering to the stored max.
        if (gone()) return;
        if (!seqs.has(v.id)) seqs.set(v.id, stored);
      }
      if (v.loops === null) {
        // Built once per video, before its first socket: a bad config or a missing prompt version fails with nothing
        // to clean up, and a reopened leg keeps the same loops (and their queues).
        const resumeAt = r;
        try {
          v.loops = factories
            .map((factory) => factory({ db, hub, sessionId: v.id, config: found.config, resumeAt }))
            .filter((loop): loop is Loop => loop !== null);
        } catch (error) {
          terminal = true;
          throw error;
        }
      }
    } catch (error) {
      if (gone()) return;
      if (!terminal && !opts.loud) {
        await legFailed(v, leg, errorText(error));
        return;
      }
      leg.dead = true;
      forget(v);
      v.leg = null;
      releaseLoops(v, { cancel: true });
      await writeFinalStatus(v, "degraded");
      throw error;
    }

    try {
      await truncateAfter(db, v.id, r);
      if (gone()) return;
      const floor = await speakerFloor(db, v.id);
      if (gone()) return;
      // A voice's talk time so far: the new leg's diarization adds to it instead of starting it again from 0.
      leg.tracker.seedTalk(await speakers.list(db, v.id));
      if (gone()) return;
      const row = await legs.open(db, v.id, { speechId: v.id, kind: "main", requestedT: r });
      leg.rowId = row.id;
      leg.requested = r;
      leg.lastT = r;
      if (gone()) {
        await endLegRow(leg, "stopped");
        return;
      }
      const link = await connect(startMessage(session, r, floor), {
        onEvent: (event) => handle(v, leg, event),
        onClose: (reason) => onLegClose(v, leg, reason),
      });
      if (gone()) {
        // Stopped (or failed) while the socket was opening: nobody else will close it.
        link.close();
        return;
      }
      leg.link = link;
    } catch (error) {
      if (gone()) return;
      if (opts.loud) {
        leg.dead = true;
        forget(v);
        v.leg = null;
        releaseLoops(v, { cancel: true });
        await endLegRow(leg, "error");
        await writeFinalStatus(v, "degraded");
        throw error;
      }
      await legFailed(v, leg, errorText(error));
    }
  }

  /** The current leg died: record it, mark the video recovering, and schedule the next leg after the backoff. */
  async function legFailed(v: Video, leg: LegState, message: string): Promise<void> {
    if (!isCurrent(v, leg)) return;
    // Dead but still the video's leg until the retry is scheduled, so nothing else opens one in between.
    leg.dead = true;
    v.lastError = message;
    leg.link?.close();
    log.warn({ sessionId: v.id, err: message, attempt: v.attempt }, "a speech leg failed; reopening after a backoff");
    v.recoveringSince ??= now();
    try {
      await endLegRow(leg, "error");
      if (v.done) return;
      let session = await sessions.setRecovering(db, v.id);
      if (!v.done && now() - v.recoveringSince >= ATTENTION_AFTER_MS) {
        const text = `recovering since ${hhmm(v.recoveringSince)} UTC: ${message}`;
        if (text !== v.attention) {
          session = await sessions.setAttention(db, v.id, text);
          v.attention = text;
        }
      }
      await publishUnlessStopped(v, session);
    } catch (error) {
      // The bookkeeping failed (the database is down); the video must still come back once it is not.
      log.error({ sessionId: v.id, err: errorText(error) }, "recording a failed leg failed; retrying anyway");
    } finally {
      // Always scheduled unless stopped: a dead leg left as v.leg would block every later open for good.
      if (!v.done && v.leg === leg) {
        const delayS = BACKOFF_S[Math.min(v.attempt, BACKOFF_S.length - 1)]!;
        v.attempt += 1;
        v.leg = null;
        v.retry = setTimer(() => {
          v.retry = null;
          openLeg(v, { loud: false }).catch((error: unknown) => log.error({ sessionId: v.id, err: errorText(error) }, "reopening a leg failed"));
        }, delayS * 1000);
      }
    }
  }

  /** Speech ended the leg because the source ended or speech stopped it: the video ends normally. */
  async function finish(v: Video, leg: LegState, reason: string): Promise<void> {
    leg.dead = true;
    forget(v);
    v.leg = null;
    releaseLoops(v);
    await endLegRow(leg, reason);
    await writeFinalStatus(v, "stopped");
  }

  async function handle(v: Video, leg: LegState, event: SpeechEvent): Promise<void> {
    // Frames still queued from a leg that failed, or from before a stop, must not extend or reopen the video.
    if (!isCurrent(v, leg)) {
      log.debug({ sessionId: v.id, type: event.type }, "dropping an event from a leg that is no longer current");
      return;
    }
    const seq = (seqs.get(v.id) ?? 0) + 1;
    seqs.set(v.id, seq);
    await events.append(db, v.id, seq, event.type, event);
    // A stop (and maybe a new leg's cut) may have happened while the append was in flight: write nothing more.
    if (!isCurrent(v, leg)) return;
    switch (event.type) {
      case "session.started": {
        // Each write re-checks the leg: a stop and an instant resume may land between them, and a replaced leg writes nothing.
        if (leg.rowId !== null) await legs.started(db, leg.rowId, event.start_at);
        if (!isCurrent(v, leg)) return;
        // Speech started later than asked (a live edge without rewind): what lies between is not covered.
        if (event.start_at > leg.requested + 1) await gaps.add(db, v.id, leg.requested, event.start_at);
        if (!isCurrent(v, leg)) return;
        leg.lastT = Math.max(leg.lastT, event.start_at);
        v.attempt = 0;
        v.recoveringSince = null;
        v.attention = null;
        await publishUnlessStopped(v, await sessions.markStarted(db, v.id, { startedAt: event.started_at, models: event.models }));
        return;
      }
      case "asr.segment": {
        const words = leg.tracker.assign(event.words);
        const stored = await segments.insert(db, v.id, { t0: event.t0, t1: event.t1, text: event.text, words });
        leg.lastT = Math.max(leg.lastT, stored.t1);
        hub.publish(v.id, { type: "segment", data: stored });
        for (const loop of v.loops ?? []) loop.advance(stored.t1);
        return;
      }
      case "health": {
        const { type: _type, ...rest } = event;
        hub.publish(v.id, { type: "health", data: { ...rest, received_at: new Date().toISOString() } });
        return;
      }
      case "diar.turns":
        // The tracker re-checks before each of its writes (its `live`).
        await leg.tracker.onTurns(event);
        return;
      case "speaker.new":
        await leg.tracker.onNew(event);
        return;
      case "speaker.merged":
        await leg.tracker.onMerged(event);
        return;
      case "session.ended": {
        if (event.reason === "error") {
          // Includes speech refusing a start whose id it still holds: one more failed attempt.
          await legFailed(v, leg, event.message || "speech ended with an error");
          return;
        }
        await finish(v, leg, event.reason);
        return;
      }
    }
  }

  async function onLegClose(v: Video, leg: LegState, reason: string): Promise<void> {
    // A leg we ended ourselves (stop, end, failure already handled) is a clean close; anything else is speech dying.
    if (!isCurrent(v, leg)) return;
    await legFailed(v, leg, `speech closed the socket: ${reason}`);
  }

  function newVideo(id: string): Video {
    const v: Video = {
      id,
      loops: null,
      leg: null,
      retry: null,
      attempt: 0,
      lastError: null,
      recoveringSince: null,
      attention: null,
      done: false,
      first: null,
    };
    videos.set(id, v);
    return v;
  }

  /** Feeds a video this process does not hold yet as a recovery: recovering first, then a leg; failures retry. */
  function revive(session: Session, since: number): Promise<Session> {
    const v = newVideo(session.id);
    v.recoveringSince = since;
    v.first = (async () => {
      let shown = session;
      try {
        shown = await sessions.setRecovering(db, v.id);
        await publishUnlessStopped(v, shown);
      } catch (error) {
        // The leg is opened anyway: its own failures (the database still down) schedule retries, so the video is never
        // held without a leg or a retry.
        log.error({ sessionId: v.id, err: errorText(error) }, "marking a revived video recovering failed; opening its leg anyway");
      }
      await holdsSettled(v.id);
      await openLeg(v, { loud: false });
      return shown;
    })();
    return v.first;
  }

  return {
    async start(sessionId) {
      const session = await sessions.get(db, sessionId);
      if (!session) throw new TerminalError(`session ${sessionId} not found`);
      // A second start while the first is still connecting must not open a second socket.
      const existing = videos.get(sessionId);
      if (existing) return existing.first ?? session;
      const v = newVideo(sessionId);
      v.first = holdsSettled(sessionId).then(() => openLeg(v, { loud: true })).then(() => session);
      return v.first;
    },
    async stop(sessionId) {
      const v = videos.get(sessionId);
      let leg: LegState | null = null;
      if (v) {
        forget(v);
        leg = v.leg;
        v.leg = null;
        if (leg) leg.dead = true;
        releaseLoops(v, { cancel: true });
      }
      const session = await sessions.setStatus(db, sessionId, "stopped");
      publishSession(session);
      leg?.link?.close();
      if (leg) await endLegRow(leg, "stopped");
      return session;
    },
    async resume(sessionId) {
      const session = await sessions.get(db, sessionId);
      if (!session) throw new TerminalError(`session ${sessionId} not found`);
      const existing = videos.get(sessionId);
      if (existing) return existing.first ?? session;
      if (session.status !== "degraded" && session.status !== "stopped") {
        throw new TerminalError(`session ${sessionId} is ${session.status}; only a degraded or stopped video can be resumed`);
      }
      return revive(session, now());
    },
    async resumeAll() {
      // Concurrently: one slow speech connect must not hold the other videos back.
      const results = await Promise.allSettled(
        (await sessions.running(db)).map(async (session) => {
          if (videos.has(session.id)) return session.id;
          // Left by a previous process: its legs died with it. Recovering keeps counting from when it first broke.
          try {
            await legs.endOpen(db, session.id, "api restarted");
          } catch (error) {
            log.error({ sessionId: session.id, err: errorText(error) }, "closing the leg rows a previous process left failed");
          }
          const since = session.recovering_since ? Date.parse(session.recovering_since) : now();
          try {
            await revive(session, since);
          } catch (error) {
            log.error({ sessionId: session.id, err: errorText(error) }, "resuming a video left running failed");
            throw error;
          }
          return session.id;
        }),
      );
      return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    },
    live: () => [...videos.keys()],
    busy: () => [...new Set([...videos.keys(), ...flushing.keys(), ...holds.keys()])],
    hold(sessionId, work) {
      const set = holds.get(sessionId) ?? new Set<Promise<unknown>>();
      holds.set(sessionId, set);
      const tracked: Promise<unknown> = work
        .catch(() => undefined)
        .finally(() => {
          set.delete(tracked);
          if (set.size === 0 && holds.get(sessionId) === set) holds.delete(sessionId);
        });
      set.add(tracked);
    },
  };
}
