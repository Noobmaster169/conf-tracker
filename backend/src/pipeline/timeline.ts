import type { Turn } from "../contracts";

/**
 * Which speaker is in force at each instant. Windows overlap; for any instant the window
 * with the latest t0 covering it wins, so a window only ever speaks for [its t0, the next
 * window's t0). Windows older than `keep` are folded into finalTalk and forgotten.
 */
export interface TimelineWindow {
  t0: number;
  t1: number;
  turns: Turn[];
}

export interface Timeline {
  windows: TimelineWindow[];
  finalTalk: Record<string, number>;
  aliases: Record<string, string>;
}

export const emptyTimeline = (): Timeline => ({ windows: [], finalTalk: {}, aliases: {} });

function clip(turns: Turn[], from: number, to: number): Turn[] {
  return turns.flatMap((t) => {
    const t0 = Math.max(t.t0, from);
    const t1 = Math.min(t.t1, to);
    return t1 > t0 ? [{ ...t, t0, t1 }] : [];
  });
}

export function effectiveTurns(windows: TimelineWindow[]): Turn[] {
  return windows
    .flatMap((w, i) => clip(w.turns, w.t0, windows[i + 1]?.t0 ?? w.t1))
    .sort((a, b) => a.t0 - b.t0);
}

export function resolve(tl: Timeline, id: string): string {
  let current = id;
  for (let hop = 0; hop < 32 && tl.aliases[current] !== undefined; hop++) current = tl.aliases[current]!;
  return current;
}

export function addAlias(tl: Timeline, from: string, into: string): Timeline {
  return { ...tl, aliases: { ...tl.aliases, [from]: into } };
}

function addTalk(into: Record<string, number>, turns: Turn[], name: (id: string) => string): Record<string, number> {
  const out = { ...into };
  for (const t of turns) out[name(t.speaker_id)] = (out[name(t.speaker_id)] ?? 0) + (t.t1 - t.t0);
  return out;
}

export function pushWindow(tl: Timeline, w: TimelineWindow, keep = 12): Timeline {
  const windows = [...tl.windows, w].sort((a, b) => a.t0 - b.t0);
  let finalTalk = tl.finalTalk;
  while (windows.length > keep) {
    const dropped = windows.shift()!;
    finalTalk = addTalk(finalTalk, clip(dropped.turns, dropped.t0, windows[0]!.t0), (id) => id);
  }
  return { ...tl, windows, finalTalk };
}

export function currentTurns(tl: Timeline): Turn[] {
  return effectiveTurns(tl.windows).map((t) => ({ ...t, speaker_id: resolve(tl, t.speaker_id) }));
}

export function talkSeconds(tl: Timeline): Record<string, number> {
  const final: Record<string, number> = {};
  for (const [id, s] of Object.entries(tl.finalTalk)) final[resolve(tl, id)] = (final[resolve(tl, id)] ?? 0) + s;
  const total = addTalk(final, currentTurns(tl), (id) => id);
  return Object.fromEntries(Object.entries(total).map(([id, s]) => [id, Math.round(s * 10) / 10]));
}
