import type { Claim, Segment, Session } from "./api/schemas";

export interface ConfigChange {
  key: string;
  a: unknown;
  b: unknown;
}

/** Keys whose values differ; speed is how fast a replay ran, not a setting that changes what it finds. */
export function configDiff(a: Record<string, unknown>, b: Record<string, unknown>, ignore: string[] = ["speed"]): ConfigChange[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !ignore.includes(k)).sort();
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((key) => ({ key, a: a[key], b: b[key] }));
}

export function formatSetting(value: unknown): string {
  if (value === undefined) return "default";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface ClaimPair {
  a: Claim | null;
  b: Claim | null;
}

const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean));

function overlap(x: Set<string>, y: Set<string>): number {
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function pairT0(pair: ClaimPair): number | null {
  const ts = [pair.a?.t0, pair.b?.t0].filter((t): t is number => typeof t === "number");
  return ts.length ? Math.min(...ts) : null;
}

/** The same claim twice is near in time and mostly the same words; best pairs first, each claim used once. */
export function matchClaims(a: Claim[], b: Claim[], opts: { windowS?: number; minOverlap?: number } = {}): ClaimPair[] {
  const windowS = opts.windowS ?? 30;
  const minOverlap = opts.minOverlap ?? 0.5;
  const bWords = b.map((c) => wordsOf(c.claim));
  const candidates: { i: number; j: number; score: number; dt: number }[] = [];
  a.forEach((ca, i) => {
    if (ca.t0 === null) return;
    const aw = wordsOf(ca.claim);
    b.forEach((cb, j) => {
      if (cb.t0 === null) return;
      const dt = Math.abs(ca.t0! - cb.t0);
      if (dt > windowS) return;
      const score = overlap(aw, bWords[j]!);
      if (score >= minOverlap) candidates.push({ i, j, score, dt });
    });
  });
  candidates.sort((x, y) => y.score - x.score || x.dt - y.dt);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: ClaimPair[] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push({ a: a[c.i]!, b: b[c.j]! });
  }
  a.forEach((ca, i) => usedA.has(i) || pairs.push({ a: ca, b: null }));
  b.forEach((cb, j) => usedB.has(j) || pairs.push({ a: null, b: cb }));
  return pairs.sort((x, y) => (pairT0(x) ?? Infinity) - (pairT0(y) ?? Infinity));
}

export interface SpeakerRun {
  t0: number;
  t1: number;
  speaker: string | null;
}

// Words of one speaker closer than this read as one stretch on the strip.
const JOIN_GAP_S = 2;

/** Who spoke when, as runs of the resolved speaker over the words, for a strip over the stream's length. */
export function speakerRuns(segments: Segment[], resolve: (id: string | null) => string | null): SpeakerRun[] {
  const runs: SpeakerRun[] = [];
  for (const segment of segments) {
    for (const word of segment.words) {
      const speaker = resolve(word.speaker_id);
      const last = runs.at(-1);
      if (last && last.speaker === speaker && word.t0 - last.t1 <= JOIN_GAP_S) last.t1 = Math.max(last.t1, word.t1);
      else runs.push({ t0: word.t0, t1: word.t1, speaker });
    }
  }
  return runs;
}

/** One is a replay of the other, or both replay the same original. */
export function sameAudio(a: Session, b: Session): boolean {
  return a.id === b.replay_of || b.id === a.replay_of || (a.replay_of !== null && a.replay_of === b.replay_of);
}
