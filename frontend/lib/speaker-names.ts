import type { Speaker } from "./api/schemas";
import { speakerResolver } from "./session-state";

export interface SpeakerLabel {
  /** The survivor's id, or null for an unlabelled word. */
  id: string | null;
  name: string | null;
  role: string | null;
}

/** A raw label to its survivor and the name the survivor goes by now, so a name reaches every earlier line and claim the moment it lands. */
export function speakerLabeller(speakers: Speaker[]): (id: string | null) => SpeakerLabel {
  const resolve = speakerResolver(speakers);
  const rows = new Map(speakers.map((s) => [s.speaker_id, s]));
  return (raw) => {
    const id = resolve(raw);
    const row = id === null ? undefined : rows.get(id);
    return { id, name: row?.name ?? null, role: row?.role ?? null };
  };
}

/** The labels the registry folded into this one. */
export function mergedFrom(speakers: Speaker[], id: string): string[] {
  return speakers.filter((s) => s.merged_into === id).map((s) => s.speaker_id);
}

/** What a voice is called before anyone has named it: "Speaker 3" for S3. */
export function voiceName(id: string | null): string {
  const n = id ? /^S(\d+)$/.exec(id)?.[1] : undefined;
  return n ? `Speaker ${n}` : "Unidentified speaker";
}
