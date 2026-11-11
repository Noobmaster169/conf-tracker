import type { Session, SpeechEvent, StartMessage } from "../contracts";
import type { Queryable } from "../db";
import { TerminalError } from "../lib/errors";
import { childLogger } from "../lib/logger";
import type { Hub } from "../realtime/hub";
import * as events from "../repositories/events";
import { resumePoint } from "../repositories/resume";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import type { Loop, LoopFactory } from "./loop";
import { createSpeakerTracker, type SpeakerTracker } from "./speaker-tracker";
import type { SpeechConnector, SpeechLink } from "./speech-client";

const log = childLogger({ module: "session-runner" });

export interface SessionRunner {
  start(sessionId: string): Promise<Session>;
  stop(sessionId: string): Promise<Session>;
  live(): string[];
}

/** Persist first, publish second: what the browser sees is always already stored. */
export function createSessionRunner(deps: { db: Queryable; hub: Hub; connect: SpeechConnector; loops?: LoopFactory[] }): SessionRunner {
  const { db, hub, connect } = deps;
  const factories = deps.loops ?? [];
  const links = new Map<string, SpeechLink>();
  const seqs = new Map<string, number>();
  const pending = new Map<string, Promise<Session>>();
  const trackers = new Map<string, SpeakerTracker>();
  const loops = new Map<string, Loop[]>();

  const publishSession = (session: Session) => hub.publish(session.id, { type: "session", data: session });

  // `cancel` is a user's stop: the stream-time runs a fast replay has queued are dropped, not paid for.
  const release = (sessionId: string, opts: { cancel?: boolean } = {}): boolean => {
    seqs.delete(sessionId);
    trackers.delete(sessionId);
    const own = loops.get(sessionId) ?? [];
    loops.delete(sessionId);
    for (const loop of own) {
      // A stop keeps only the run in flight and the final pass over everything (extractor only); an end drains the
      // whole queue, so a finished replay's claims keep arriving. Detached either way: a stop must not wait on a model.
      if (opts.cancel) loop.cancelQueued();
      void loop
        .flush()
        .catch((error: unknown) => log.error({ sessionId, err: error instanceof Error ? error.message : String(error) }, "final loop run failed"))
        .finally(() => loop.stop());
    }
    return links.delete(sessionId);
  };

  async function handle(sessionId: string, event: SpeechEvent): Promise<void> {
    // Frames still queued when stop() ran must not reopen or extend a stopped session.
    if (!links.has(sessionId)) {
      log.debug({ sessionId, type: event.type }, "dropping an event for a session that is no longer live");
      return;
    }
    const seq = (seqs.get(sessionId) ?? 0) + 1;
    seqs.set(sessionId, seq);
    await events.append(db, sessionId, seq, event.type, event);
    switch (event.type) {
      case "session.started": {
        publishSession(await sessions.markStarted(db, sessionId, { startedAt: event.started_at, models: event.models }));
        return;
      }
      case "asr.segment": {
        const words = trackers.get(sessionId)?.assign(event.words) ?? event.words.map((w) => ({ ...w, speaker_id: null }));
        const stored = await segments.insert(db, sessionId, { t0: event.t0, t1: event.t1, text: event.text, words });
        hub.publish(sessionId, { type: "segment", data: stored });
        for (const loop of loops.get(sessionId) ?? []) loop.advance(stored.t1);
        return;
      }
      case "health": {
        const { type: _type, ...rest } = event;
        hub.publish(sessionId, { type: "health", data: { ...rest, received_at: new Date().toISOString() } });
        return;
      }
      case "diar.turns":
        await trackers.get(sessionId)?.onTurns(event);
        return;
      case "speaker.new":
        await trackers.get(sessionId)?.onNew(event);
        return;
      case "speaker.merged":
        await trackers.get(sessionId)?.onMerged(event);
        return;
      case "session.ended": {
        release(sessionId);
        if (event.reason === "error") {
          log.error({ sessionId, message: event.message }, "speech ended the session with an error");
          publishSession(await sessions.setError(db, sessionId, event.message || "speech ended with an error"));
          return;
        }
        publishSession(await sessions.setStatus(db, sessionId, "stopped"));
        return;
      }
    }
  }

  async function onClose(sessionId: string, reason: string): Promise<void> {
    // A link we removed ourselves (stop, or session.ended) is a clean close; anything else is speech dying.
    if (!release(sessionId)) return;
    log.warn({ sessionId, reason }, "speech closed the socket while the session was live");
    publishSession(await sessions.setStatus(db, sessionId, "degraded"));
  }

  async function connectSession(session: Session): Promise<Session> {
    const sessionId = session.id;
    const speed = session.config.speed;
    // A replay's url is kept for the page's embed; speech reads the stored recording instead.
    const replayOf = session.replay_of ?? undefined;
    const start: StartMessage = {
      session_id: sessionId,
      url: replayOf ? undefined : (session.source_url ?? undefined),
      file: replayOf ? undefined : (session.source_file ?? undefined),
      replay_of: replayOf,
      speed: typeof speed === "number" ? speed : undefined,
      config: session.config,
    };
    // The loops' first boundaries come after what is already stored, so a restarted video does not replay them all.
    const resumeAt = await resumePoint(db, sessionId);
    // Built before the socket opens: a bad config or a missing prompt version fails the start with nothing to clean up.
    let own: Loop[];
    try {
      own = factories.map((factory) => factory({ db, hub, sessionId, config: session.config, resumeAt })).filter((loop): loop is Loop => loop !== null);
    } catch (error) {
      publishSession(await sessions.setStatus(db, sessionId, "degraded"));
      throw error;
    }
    // Numbering continues from storage so a restarted backend never reuses a stored seq.
    seqs.set(sessionId, await events.maxSeq(db, sessionId));
    trackers.set(sessionId, createSpeakerTracker({ db, hub, sessionId }));
    try {
      const link = await connect(start, {
        onEvent: (event) => handle(sessionId, event),
        onClose: (reason) => onClose(sessionId, reason),
      });
      links.set(sessionId, link);
      if (own.length > 0) loops.set(sessionId, own);
    } catch (error) {
      seqs.delete(sessionId);
      trackers.delete(sessionId);
      publishSession(await sessions.setStatus(db, sessionId, "degraded"));
      throw error;
    }
    return session;
  }

  return {
    async start(sessionId) {
      const session = await sessions.get(db, sessionId);
      if (!session) throw new TerminalError(`session ${sessionId} not found`);
      if (links.has(sessionId)) return session;
      // A second start while the first is still connecting must not open a second socket.
      const inFlight = pending.get(sessionId);
      if (inFlight) return inFlight;
      const connecting = connectSession(session);
      pending.set(sessionId, connecting);
      try {
        return await connecting;
      } finally {
        pending.delete(sessionId);
      }
    },
    async stop(sessionId) {
      const link = links.get(sessionId);
      release(sessionId, { cancel: true });
      const session = await sessions.setStatus(db, sessionId, "stopped");
      publishSession(session);
      link?.close();
      return session;
    },
    live: () => [...links.keys()],
  };
}
