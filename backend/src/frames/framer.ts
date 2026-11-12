import { FrameSettings } from "../contracts-frames";
import type { Queryable } from "../db";
import { childLogger } from "../lib/logger";
import * as frames from "../repositories/frames";
import * as segments from "../repositories/segments";
import * as sessions from "../repositories/sessions";
import * as settings from "../repositories/settings";
import type { Media, Resolved } from "./media";
import { createJudge, type Judge, type Signed } from "./signature";
import type { FrameStore } from "./store";

const log = childLogger({ module: "framer" });

export const SETTINGS_KEY = "frames";
// A live manifest is good for hours; resolved again after this, or at once after a failed grab.
const MANIFEST_TTL_MS = 30 * 60 * 1000;
// The newest HLS segment ends a few seconds before now.
const LIVE_LAG_S = 6;
const BLOCKED_TTL_MS = 60 * 1000;

export interface FramerDeps {
  db: Queryable;
  media: Media;
  store: FrameStore;
  /** The videos running now. */
  live: () => string[];
  now?: () => number;
}

interface VideoState {
  busy: boolean;
  resolved: Resolved | null;
  resolvedAt: number;
  judge: Judge | null;
  lastError: string | null;
  lastAt: number | null;
  kept: number;
}

export interface FramerStatus {
  enabled: boolean;
  videos: { session_id: string; kept: number; last_at: string | null; last_error: string | null; mode: "live" | "recording" | "unknown" }[];
  filling: { session_id: string; started_at: string; seen: number; kept: number; error: string | null; done_at: string | null }[];
}

export async function frameSettings(db: Queryable): Promise<FrameSettings> {
  const stored = (await settings.get<unknown>(db, SETTINGS_KEY))?.value;
  const parsed = FrameSettings.safeParse(stored ?? {});
  return parsed.success ? parsed.data : FrameSettings.parse({});
}

/**
 * Pictures of every running video, beside the session runner and never inside it: a failed grab is a log line and the
 * video does not notice. A live stream gets a frame at its live edge every interval_s; a recording is sampled whole by
 * `fill`, which also runs by itself the first time a running video turns out to be a recording.
 */
export function createFramer(deps: FramerDeps) {
  const { db, media, store } = deps;
  const now = deps.now ?? Date.now;
  const videos = new Map<string, VideoState>();
  const fills = new Map<string, FramerStatus["filling"][number]>();
  let blocked: { at: number; list: Signed[] } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function blockedList(): Promise<Signed[]> {
    if (!blocked || now() - blocked.at > BLOCKED_TTL_MS) blocked = { at: now(), list: await frames.blockedSignatures(db) };
    return blocked.list;
  }

  async function judgeFor(sessionId: string): Promise<Judge> {
    return createJudge(await frames.signatures(db, sessionId), await blockedList());
  }

  async function keep(sessionId: string, t: number, signed: Signed, grab: { image: Uint8Array; thumb: Uint8Array; width: number; height: number }) {
    const stamp = t.toFixed(1);
    const key = `frames/${sessionId}/${stamp}.webp`;
    const thumbKey = `frames/${sessionId}/${stamp}_thumb.webp`;
    await store.put(key, grab.image, "image/webp");
    await store.put(thumbKey, grab.thumb, "image/webp");
    return frames.add(db, { sessionId, t, key, thumbKey, width: grab.width, height: grab.height, ...signed }, store.url);
  }

  /** The stream time of a frame taken now: the broadcast's clock when a leg said when it began, else the transcript's end. */
  async function streamTimeNow(sessionId: string): Promise<number | null> {
    const { rows } = await db.query<{ b: number }>(
      `select (payload->>'broadcast_start')::float8 as b from events
        where session_id = $1 and type = 'session.started' and jsonb_typeof(payload->'broadcast_start') = 'number'
        order by seq desc limit 1`,
      [sessionId],
    );
    if (rows[0]) return Math.max(0, now() / 1000 - rows[0].b - LIVE_LAG_S);
    const last = await segments.lastUpTo(db, sessionId, Number.POSITIVE_INFINITY);
    return last ? last.t1 : null;
  }

  async function grabOnce(sessionId: string, state: VideoState, s: FrameSettings): Promise<void> {
    const session = await sessions.get(db, sessionId);
    if (!session?.source_url) return;
    if (!state.resolved || now() - state.resolvedAt > MANIFEST_TTL_MS) {
      state.resolved = await media.resolve(session.source_url);
      state.resolvedAt = now();
    }
    if (!state.resolved.live) {
      // A recording: sampled whole, once per process (what is already kept is skipped as the same picture).
      if (!fills.has(sessionId)) void fill(sessionId).catch((error: unknown) => log.warn({ sessionId, err: String(error) }, "fill did not start"));
      return;
    }
    const t = await streamTimeNow(sessionId);
    // Without a broadcast clock a recovering video's transcript lags the live edge: its time would be wrong.
    if (t === null || (session.status !== "live" && !(await hasClock(sessionId)))) return;
    state.judge ??= await judgeFor(sessionId);
    const grab = await media.grabLive(state.resolved.media, s);
    const verdict = state.judge.offer(grab.sig, { t, grab }, s);
    if (verdict) {
      await keep(sessionId, verdict.keep.payload.t, { sig: verdict.keep.sig, motion: verdict.keep.motion }, verdict.keep.payload.grab);
      state.kept++;
    }
  }

  async function hasClock(sessionId: string): Promise<boolean> {
    const { rows } = await db.query("select 1 from events where session_id = $1 and type = 'session.started' and jsonb_typeof(payload->'broadcast_start') = 'number' limit 1", [sessionId]);
    return rows.length > 0;
  }

  async function pass(): Promise<void> {
    const s = await frameSettings(db);
    if (!s.enabled) return;
    const live = new Set(deps.live());
    for (const id of videos.keys()) if (!live.has(id)) videos.delete(id);
    await Promise.all(
      [...live].map(async (id) => {
        let state = videos.get(id);
        if (!state) {
          state = { busy: false, resolved: null, resolvedAt: 0, judge: null, lastError: null, lastAt: null, kept: 0 };
          videos.set(id, state);
        }
        if (state.busy) return;
        state.busy = true;
        try {
          await grabOnce(id, state, s);
          state.lastAt = now();
          state.lastError = null;
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (state.lastError !== text) log.warn({ sessionId: id, err: text }, "frame grab failed");
          state.lastError = text;
          // The manifest may have expired, and the next grab is no continuation of the last one.
          state.resolved = null;
          state.judge?.reset();
        } finally {
          state.busy = false;
        }
      }),
    );
  }

  /**
   * Samples a whole recording (a recorded video, or a live one once YouTube serves its recording) every interval_s and
   * keeps what the judge keeps. In the background; one at a time per video.
   */
  async function fill(sessionId: string, opts: { from?: number } = {}): Promise<void> {
    const session = await sessions.get(db, sessionId);
    if (!session?.source_url) throw new Error("this video has no YouTube source");
    const running = fills.get(sessionId);
    if (running && !running.done_at) throw new Error("already filling this video");
    const status = { session_id: sessionId, started_at: new Date(now()).toISOString(), seen: 0, kept: 0, error: null as string | null, done_at: null as string | null };
    fills.set(sessionId, status);
    const s = await frameSettings(db);
    const judge = await judgeFor(sessionId);
    log.info({ sessionId, from: opts.from ?? 0 }, "filling frames from the recording");
    try {
      await media.sample(session.source_url, { from: opts.from ?? 0, intervalS: s.interval_s, width: s.width }, async ({ t, sig, still }) => {
        if (stopped) return;
        status.seen++;
        const verdict = judge.offer(sig, { t, still }, s);
        if (!verdict) return;
        const grab = await media.encode(verdict.keep.payload.still, s);
        await keep(sessionId, verdict.keep.payload.t, { sig: verdict.keep.sig, motion: verdict.keep.motion }, grab);
        status.kept++;
      });
      log.info({ sessionId, seen: status.seen, kept: status.kept }, "filled frames from the recording");
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
      log.warn({ sessionId, err: status.error, seen: status.seen, kept: status.kept }, "filling frames failed");
    } finally {
      status.done_at = new Date(now()).toISOString();
    }
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    let wait = 10_000;
    try {
      const s = await frameSettings(db);
      wait = s.interval_s * 1000;
      await pass();
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, "framer pass failed");
    }
    if (!stopped) timer = setTimeout(() => void loop(), wait);
  }

  return {
    start() {
      void loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    pass,
    /** Starts a fill in the background; throws at once when it cannot start. */
    async startFill(sessionId: string, opts: { from?: number } = {}): Promise<void> {
      const running = fills.get(sessionId);
      if (running && !running.done_at) throw new Error("already filling this video");
      const session = await sessions.get(db, sessionId);
      if (!session) throw new Error("video not found");
      if (!session.source_url) throw new Error("this video has no YouTube source");
      void fill(sessionId, opts).catch((error: unknown) => log.warn({ sessionId, err: String(error) }, "fill did not start"));
    },
    /** Forgets what is cached about blocked screens and kept frames, after a frame was hidden or blocked. */
    invalidate() {
      blocked = null;
      for (const v of videos.values()) v.judge = null;
    },
    async status(): Promise<FramerStatus> {
      const s = await frameSettings(db);
      return {
        enabled: s.enabled,
        videos: [...videos.entries()].map(([id, v]) => ({
          session_id: id,
          kept: v.kept,
          last_at: v.lastAt === null ? null : new Date(v.lastAt).toISOString(),
          last_error: v.lastError,
          mode: v.resolved ? (v.resolved.live ? "live" : "recording") : "unknown",
        })),
        filling: [...fills.values()],
      };
    },
  };
}
export type Framer = ReturnType<typeof createFramer>;
