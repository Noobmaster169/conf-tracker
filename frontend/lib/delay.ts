/** A segment with no arrival came with the snapshot and is never held back: a reload must not hide the backlog. */
function readyAt(id: number, arrivals: Record<number, number>, delayS: number): number {
  const at = arrivals[id];
  return at === undefined ? 0 : at + delayS * 1000;
}

/** The items the page may show now, each live one held back delayS seconds from when it arrived. */
export function delayed<T extends { id: number }>(items: T[], arrivals: Record<number, number>, nowMs: number, delayS: number): T[] {
  if (delayS <= 0) return items;
  return items.filter((item) => readyAt(item.id, arrivals, delayS) <= nowMs);
}

/** The clock time (ms) the next item held back at nowMs becomes due, or null when none is held. */
export function nextRevealAt(items: { id: number }[], arrivals: Record<number, number>, nowMs: number, delayS: number): number | null {
  if (delayS <= 0) return null;
  const due = items.map((item) => readyAt(item.id, arrivals, delayS)).filter((at) => at > nowMs);
  return due.length === 0 ? null : Math.min(...due);
}
