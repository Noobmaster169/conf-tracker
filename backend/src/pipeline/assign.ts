import type { Turn, Word } from "../contracts";

type RawWord = Omit<Word, "speaker_id"> & { speaker_id?: string | null };

/** Spec 5.2: the turn with the most time overlap, null when none overlaps at all. */
export function speakerAt(turns: Turn[], t0: number, t1: number): string | null {
  let best: string | null = null;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap = Math.min(turn.t1, t1) - Math.max(turn.t0, t0);
    if (overlap > bestOverlap) {
      best = turn.speaker_id;
      bestOverlap = overlap;
    }
  }
  return best;
}

export function assignWords(words: ReadonlyArray<RawWord>, turns: Turn[]): Word[] {
  return words.map(({ speaker_id: _old, ...w }) => {
    // Whisper sometimes gives a word no duration; widen it so it can still overlap a turn.
    const [t0, t1] = w.t1 > w.t0 ? [w.t0, w.t1] : [w.t0 - 0.01, w.t1 + 0.01];
    return { ...w, speaker_id: speakerAt(turns, t0, t1) };
  });
}

export function sameSpeakers(a: Word[], b: Word[]): boolean {
  return a.length === b.length && a.every((w, i) => w.speaker_id === b[i]?.speaker_id);
}
