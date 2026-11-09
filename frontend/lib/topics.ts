export const TOPICS_WINDOW_S = 600;
const BUCKET_S = 30;

/** The last ten minutes of stream time, snapped up to 30 s so the request changes twice a minute, not with every segment. */
export function topicsRange(lastT: number): { from: number; to: number } {
  const to = Math.ceil(lastT / BUCKET_S) * BUCKET_S;
  return { from: Math.max(0, to - TOPICS_WINDOW_S), to };
}
