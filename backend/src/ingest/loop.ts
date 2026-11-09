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
export type LoopFactory = (input: { db: Queryable; hub: Hub; sessionId: string; config: Record<string, unknown> }) => Loop | null;

/**
 * A per-session job on stream time, one run at a time. Runs queue instead of skipping, so a replay faster than
 * the model makes the same calls a live run would, only later.
 */
export function createLoop(run: (upTo: number) => Promise<void>, opts: { intervalS: number; finalRun: boolean }): Loop {
  let queue: Promise<void> = Promise.resolve();
  let next = opts.intervalS;
  let stopped = false;
  // Bumped by cancelQueued: a run queued under an older generation is skipped when its turn comes.
  let generation = 0;

  function tick(upTo = Number.POSITIVE_INFINITY): Promise<void> {
    const queuedIn = generation;
    // Runs log their own failures; one that throws anyway must not wedge the queue.
    queue = queue.then(() => (stopped || queuedIn !== generation ? undefined : run(upTo))).catch(() => undefined);
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
    },
    stop() {
      stopped = true;
    },
  };
}
