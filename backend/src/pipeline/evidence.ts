import type { Line } from "./lines";

export function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface Located {
  speaker_id: string | null;
  t0: number;
  t1: number;
}

/**
 * The evidence check. The quote must be a substring of the lines' text with only whitespace
 * forgiven; the line it starts in names the speaker, so the model never chooses who spoke.
 * The last occurrence wins: the new lines come after the context, and a repeat is theirs.
 */
export function locateQuote(lines: Line[], quote: string): Located | null {
  const needle = normalise(quote);
  if (needle === "") return null;
  const spans: { start: number; end: number }[] = [];
  let joined = "";
  for (const line of lines) {
    const text = normalise(line.text);
    if (joined !== "") joined += " ";
    spans.push({ start: joined.length, end: joined.length + text.length });
    joined += text;
  }
  const at = joined.lastIndexOf(needle);
  if (at === -1) return null;
  const end = at + needle.length;
  const hit = lines.filter((_, i) => spans[i]!.end > at && spans[i]!.start < end);
  const first = hit[0];
  const last = hit.at(-1);
  if (!first || !last) return null;
  return { speaker_id: first.speaker_id, t0: first.t0, t1: last.t1 };
}

const key = (text: string): string => normalise(text).toLowerCase();

/** A claim already shown to the model as extracted, or one whose quote is the same words. */
export function isDuplicate(candidate: { claim: string; quote: string }, prior: { claim: string; quote: string }[]): boolean {
  const claim = key(candidate.claim);
  const quote = key(candidate.quote);
  return prior.some((p) => key(p.claim) === claim || (quote !== "" && key(p.quote) === quote));
}
