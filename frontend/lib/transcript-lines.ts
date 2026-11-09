import type { Segment, Speaker } from "./api/schemas";
import { speakerResolver } from "./session-state";

export interface Line {
  key: string;
  segmentId: number;
  t0: number;
  speakerId: string | null;
  text: string;
  revision: number;
}

/** An unlabelled word (a filler the diarizer missed) takes its neighbour's speaker so it does not split a sentence. */
function foldUnlabelled(ids: (string | null)[]): (string | null)[] {
  const firstLabelled = ids.find((id) => id !== null) ?? null;
  let previous: string | null = null;
  return ids.map((id) => {
    previous = id ?? previous;
    return previous ?? firstLabelled;
  });
}

/** One line per run of words by the same speaker, after merges, so a merge recolours history too. */
export function toLines(segments: Segment[], speakers: Speaker[], revisions: Record<number, number>): Line[] {
  const resolve = speakerResolver(speakers);
  return segments.flatMap((segment) => {
    const revision = revisions[segment.id] ?? 0;
    if (segment.words.length === 0) {
      return [{ key: `${segment.id}:0`, segmentId: segment.id, t0: segment.t0, speakerId: null, text: segment.text, revision }];
    }
    const ids = foldUnlabelled(segment.words.map((word) => resolve(word.speaker_id)));
    const lines: Line[] = [];
    for (const [i, word] of segment.words.entries()) {
      const speakerId = ids[i] ?? null;
      const last = lines.at(-1);
      if (last && last.speakerId === speakerId) {
        last.text = `${last.text} ${word.w}`;
        continue;
      }
      lines.push({ key: `${segment.id}:${lines.length}`, segmentId: segment.id, t0: word.t0, speakerId, text: word.w, revision });
    }
    return lines;
  });
}
