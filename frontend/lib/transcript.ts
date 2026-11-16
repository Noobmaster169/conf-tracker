import type { Person } from "@/lib/api/conference";
import type { Segment, Speaker } from "@/lib/api/schemas";
import { speakerResolver } from "@/lib/session-state";

/** One stretch of the transcript by one voice: its lines run together. `name` is null for a voice nobody has named. */
export interface TranscriptTurn {
  speakerId: string | null;
  name: string | null;
  t0: number;
  text: string;
}

/** The voice that says most of a line's words, after merges; null when no word carries one. */
function voiceOf(segment: Segment, resolve: (id: string | null) => string | null): string | null {
  const counts = new Map<string, number>();
  for (const word of segment.words) {
    const id = resolve(word.speaker_id);
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [id, n] of counts) if (best === null || n > counts.get(best)!) best = id;
  return best;
}

/**
 * A session's transcript as turns: consecutive lines of the same voice joined, in time order. A voice is named by the
 * person it was matched to, else by the name the Namer gave it.
 */
export function transcriptTurns(segments: Segment[], speakers: Speaker[], people: Person[]): TranscriptTurn[] {
  const resolve = speakerResolver(speakers);
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const nameOf = (id: string | null): string | null => {
    const speaker = id === null ? undefined : speakers.find((s) => s.speaker_id === id);
    if (!speaker) return null;
    return (speaker.person_id !== null ? personName.get(speaker.person_id) : undefined) ?? speaker.name;
  };
  const turns: TranscriptTurn[] = [];
  for (const segment of [...segments].sort((a, b) => a.t0 - b.t0)) {
    const text = segment.text.trim();
    if (!text) continue;
    const speakerId = voiceOf(segment, resolve);
    const last = turns.at(-1);
    if (last && last.speakerId === speakerId) last.text = `${last.text} ${text}`;
    else turns.push({ speakerId, name: nameOf(speakerId), t0: segment.t0, text });
  }
  return turns;
}
