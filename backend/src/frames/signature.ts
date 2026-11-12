/**
 * Whether a grab is a new picture or one the gallery already has, by code alone (no model call per frame).
 *
 * A grab is reduced to a signature: 64x36 grey, each value the mean of a block of the frame. Two signatures are compared
 * cell by cell. Measured on 90 minutes of day 1 (527 distinct grabs every 10 s -> ~95 kept, almost every slide):
 * - coarse: under coarse_frac of cells differ by more than coarse_delta. Alone it merges slides that share a white
 *   template and differ only in their text.
 * - fine: over the cells that moved in neither grab's motion mask (a slide stays still while the speaker beside it
 *   moves), under fine_frac differ by more than fine_delta. That is what tells two such slides apart.
 * A frame is the same as a kept one when both say so.
 */

export const SIG_W = 64;
export const SIG_H = 36;
export const SIG_CELLS = SIG_W * SIG_H;
/** A cell that changed by more than this between a grab and the next one moved. */
export const MOTION_DELTA = 6;
/** Fewer static cells than this, and the fine test has too little to go on: coarse decides alone. */
const MIN_STATIC = 200;

export interface Thresholds {
  coarse_delta: number;
  coarse_frac: number;
  fine_delta: number;
  fine_frac: number;
  settle_frac: number;
}

export interface Signed {
  sig: Uint8Array;
  motion: Uint8Array;
}

function check(a: Uint8Array): void {
  if (a.length !== SIG_CELLS) throw new Error(`a signature has ${SIG_CELLS} cells, not ${a.length}`);
}

/** The cells that changed by more than MOTION_DELTA between two grabs, as 1s. */
export function motionBetween(a: Uint8Array, b: Uint8Array): Uint8Array {
  check(a);
  check(b);
  const out = new Uint8Array(SIG_CELLS);
  for (let i = 0; i < SIG_CELLS; i++) out[i] = Math.abs(a[i]! - b[i]!) > MOTION_DELTA ? 1 : 0;
  return out;
}

/** The share of cells that moved: a grab has settled when the next one is close to it (a crossfade never is). */
export function movedShare(motion: Uint8Array): number {
  let n = 0;
  for (const m of motion) n += m;
  return n / motion.length;
}

export function settled(motion: Uint8Array, t: Thresholds): boolean {
  return movedShare(motion) < t.settle_frac;
}

/** Whether two kept-or-candidate frames show the same picture. */
export function same(a: Signed, b: Signed, t: Thresholds): boolean {
  check(a.sig);
  check(b.sig);
  let coarse = 0;
  let statics = 0;
  let fine = 0;
  for (let i = 0; i < SIG_CELLS; i++) {
    const d = Math.abs(a.sig[i]! - b.sig[i]!);
    if (d > t.coarse_delta) coarse++;
    if (a.motion[i] === 0 && b.motion[i] === 0) {
      statics++;
      if (d > t.fine_delta) fine++;
    }
  }
  if (coarse / SIG_CELLS >= t.coarse_frac) return false;
  if (statics < MIN_STATIC) return true;
  return fine / statics < t.fine_frac;
}

/**
 * One video's run of grabs. `offer` takes each grab in time order and answers the one to keep, if any: the grab before
 * it, once this one shows it settled and it is like nothing kept and nothing blocked.
 */
export function createJudge(kept: Signed[], blocked: Signed[]) {
  let candidate: { sig: Uint8Array; payload: unknown } | null = null;
  return {
    offer<P>(sig: Uint8Array, payload: P, t: Thresholds): { keep: Signed & { payload: P } } | null {
      check(sig);
      const before = candidate;
      if (before) {
        const motion = motionBetween(before.sig, sig);
        if (settled(motion, t)) {
          candidate = null;
          const signed = { sig: before.sig, motion };
          if (blocked.some((b) => same(signed, b, t)) || kept.some((k) => same(signed, k, t))) return null;
          kept.push(signed);
          return { keep: { ...signed, payload: before.payload as P } };
        }
      }
      candidate = { sig, payload };
      return null;
    },
    /** Forgets the candidate: the next grab is not a continuation of the last (a gap, a break). */
    reset() {
      candidate = null;
    },
    kept,
  };
}
export type Judge = ReturnType<typeof createJudge>;
