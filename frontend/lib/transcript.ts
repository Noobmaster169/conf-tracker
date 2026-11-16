import type { Person } from "@/lib/api/conference";
import type { Segment, Speaker } from "@/lib/api/schemas";
import { titleAndOrg } from "@/lib/format";
import { speakerResolver } from "@/lib/session-state";

/** A paragraph closes once it reaches this many characters, at the end of a line, so a long turn reads in pieces. */
export const PARAGRAPH_CHARS = 240;

export interface TranscriptParagraph {
  t0: number;
  text: string;
}

/**
 * One stretch of the transcript by one voice, in paragraphs. `name` is null for a voice nobody has named; `about` is
 * the matched person's title and company, when known.
 */
export interface TranscriptTurn {
  speakerId: string | null;
  name: string | null;
  about: string | null;
  paragraphs: TranscriptParagraph[];
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
 * A session's transcript as turns: consecutive lines of the same voice together, in time order, in paragraphs. A voice
 * is named by the person it was matched to, else by the name the Namer gave it.
 */
export function transcriptTurns(segments: Segment[], speakers: Speaker[], people: Person[]): TranscriptTurn[] {
  const resolve = speakerResolver(speakers);
  const personById = new Map(people.map((p) => [p.id, p]));
  const who = (id: string | null): Pick<TranscriptTurn, "name" | "about"> => {
    const speaker = id === null ? undefined : speakers.find((s) => s.speaker_id === id);
    const person = speaker?.person_id != null ? personById.get(speaker.person_id) : undefined;
    return { name: person?.name ?? speaker?.name ?? null, about: person ? titleAndOrg(person) : null };
  };
  const turns: TranscriptTurn[] = [];
  for (const segment of [...segments].sort((a, b) => a.t0 - b.t0)) {
    const text = segment.text.trim();
    if (!text) continue;
    const speakerId = voiceOf(segment, resolve);
    const last = turns.at(-1);
    if (!last || last.speakerId !== speakerId) {
      turns.push({ speakerId, ...who(speakerId), paragraphs: [{ t0: segment.t0, text }] });
      continue;
    }
    const paragraph = last.paragraphs.at(-1)!;
    if (paragraph.text.length >= PARAGRAPH_CHARS) last.paragraphs.push({ t0: segment.t0, text });
    else paragraph.text = `${paragraph.text} ${text}`;
  }
  return turns;
}
