import type { TalkSpeaker } from "./api/conference";

/**
 * A session's speakers as one line of text, the way the admin types them: people separated by `;`, each
 * `Name, Organisation, Title`, with `(moderator)` or `(host)` after one who is not a speaker.
 */
const ROLE = /\((moderator|host)\)\s*$/i;

export interface SpeakerInput {
  name: string;
  org: string | null;
  title: string | null;
  role: "speaker" | "moderator" | "host";
}

export function parseSpeakers(text: string): SpeakerInput[] {
  return text
    .split(/[;\n]/)
    .map((raw) => {
      const role = (ROLE.exec(raw)?.[1]?.toLowerCase() ?? "speaker") as SpeakerInput["role"];
      const [name = "", org = "", ...title] = raw.replace(ROLE, "").split(",").map((part) => part.trim());
      return { name, org: org || null, title: title.join(", ") || null, role };
    })
    .filter((speaker) => speaker.name !== "");
}

export function formatSpeakers(speakers: TalkSpeaker[]): string {
  return speakers
    .map((s) => {
      const parts = s.title ? [s.name, s.org ?? "", s.title] : s.org ? [s.name, s.org] : [s.name];
      return `${parts.join(", ")}${s.role === "speaker" ? "" : ` (${s.role})`}`;
    })
    .join("; ");
}
