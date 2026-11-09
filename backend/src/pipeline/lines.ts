import type { Segment } from "../contracts";

export interface Line {
  segment_id: number;
  t0: number;
  t1: number;
  speaker_id: string | null;
  text: string;
}

/** An unlabelled word takes its previous neighbour's speaker, or the first labelled one when it leads, so a filler never splits a sentence. Mirrors frontend/lib/transcript-lines.ts. */
function fold(ids: (string | null)[]): (string | null)[] {
  const first = ids.find((id) => id !== null) ?? null;
  let previous: string | null = null;
  return ids.map((id) => {
    previous = id ?? previous;
    return previous ?? first;
  });
}

/** One line per run of words by the same speaker, the unit the model quotes from and the evidence check attributes to. */
export function segmentsToLines(segments: Segment[]): Line[] {
  return segments.flatMap((segment) => {
    if (segment.words.length === 0) return [{ segment_id: segment.id, t0: segment.t0, t1: segment.t1, speaker_id: null, text: segment.text }];
    const ids = fold(segment.words.map((word) => word.speaker_id));
    const lines: Line[] = [];
    segment.words.forEach((word, i) => {
      const speaker = ids[i] ?? null;
      const last = lines.at(-1);
      if (last && last.speaker_id === speaker) {
        last.text = `${last.text} ${word.w}`;
        last.t1 = word.t1;
        return;
      }
      lines.push({ segment_id: segment.id, t0: word.t0, t1: word.t1, speaker_id: speaker, text: word.w });
    });
    return lines;
  });
}
