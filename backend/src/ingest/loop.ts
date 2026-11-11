import type { Queryable } from "../db";
import type { Hub } from "../realtime/hub";

export interface Loop {
  /** Stream time reached t: every interval boundary it passed is queued as a run over the lines up to that boundary. */
  advance(t: number): void;
  /** Queues one run over the lines that end by upTo (all of them by default) and resolves when it is done. */
  tick(upTo?: number): Promise<void>;
  /** Waits for the queue; a loop made with finalRun then runs once more over everything, so the tail is not lost. */
  flush(): Promise<void>;
  /** Drops the runs queued so far that have not started; the one in flight finishes, and later ticks run as usual. */
  cancelQueued(): void;
  /** Nothing runs after this, including what is still queued. */
  stop(): void;
}

/** What the session runner is given: one per kind of loop. Null means this session does not run it; a throw refuses the session's config. */
export type LoopFactory = (input: { db: Queryable; hub: Hub; sessionId: string; config: Record<string, unknown>; resumeAt: number }) => Loop | null;

/** A loop that also takes one-off jobs on its queue, so they never run alongside a tick. */
export interface QueuedLoop extends Loop {
  /** Queues a job behind the runs already queued; it is skipped, as a run would be, after stop or cancelQueued. `live` turns false once the loop stops. */
  enqueue(job: (live: () => boolean) => Promise<void>): Promise<void>;
}

/**
 * A per-session job on stream time, one run at a time. Runs queue instead of skipping, so a replay faster than
 * the model makes the same calls a live run would, only later. With latestOnly, a run whose turn comes when a newer
 * one is already queued is skipped: a job that only cares about now (naming who is talking) keeps up with a stream
 * faster than the model instead of answering for minutes ago. With startAfter (stored progress of an earlier run), the
 * first boundary is the first one after it, so a resumed video does not replay every boundary from 0.
 */
export function createLoop(
  run: (upTo: number) => Promise<void>,
  opts: { intervalS: number; finalRun: boolean; latestOnly?: boolean; startAfter?: number },
): QueuedLoop {
  let queue: Promise<void> = Promise.resolve();
  let next = opts.intervalS * (Math.floor((opts.startAfter ?? 0) / opts.intervalS) + 1);
  let stopped = false;
  // Bumped by cancelQueued: a run queued under an older generation is skipped when its turn comes.
  let generation = 0;
  // The furthest upTo queued in this generation, which latestOnly runs up to.
  let newest = Number.NEGATIVE_INFINITY;

  function tick(upTo = Number.POSITIVE_INFINITY): Promise<void> {
    newest = Math.max(newest, upTo);
    const superseded = () => opts.latestOnly === true && upTo < newest;
    return enqueue(() => (superseded() ? Promise.resolve() : run(upTo)));
  }

  function enqueue(job: (live: () => boolean) => Promise<void>): Promise<void> {
    const queuedIn = generation;
    // Runs log their own failures; one that throws anyway must not wedge the queue.
    queue = queue.then(() => (stopped || queuedIn !== generation ? undefined : job(() => !stopped))).catch(() => undefined);
    return queue;
  }

  return {
    advance(t) {
      while (!stopped && t >= next) {
        void tick(next);
        next += opts.intervalS;
      }
    },
    tick,
    enqueue,
    async flush() {
      let seen: Promise<void>;
      do {
        seen = queue;
        await seen;
      } while (seen !== queue);
      if (opts.finalRun && !stopped) await tick();
    },
    cancelQueued() {
      generation++;
      newest = Number.NEGATIVE_INFINITY;
    },
    stop() {
      stopped = true;
    },
  };
}
