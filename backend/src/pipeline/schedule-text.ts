import { type Talk, TalkBody, TalkKind, type TalkSpeakerBody } from "../contracts";

/**
 * A schedule as pasted text, one talk per line, fields separated by `|`:
 *
 *   10:00-10:30 | Opening keynote | Anatoly Yakovenko, Solana Labs, Co-Founder | keynote
 *   10:30-11:15 | The state of DeFi | Jane Doe, Acme, CEO; John Roe, Beta (moderator) | panel
 *
 * Time and kind are optional. Speakers are separated by `;`, each `Name, Organisation, Title`, with `(moderator)` or
 * `(host)` after one who is not a speaker. Blank lines and lines starting with `#` are skipped.
 */

const TIME = /^(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?$/;
const ROLE = /\((moderator|host)\)\s*$/i;

function parseSpeaker(raw: string): TalkSpeakerBody | null {
  const role = ROLE.exec(raw)?.[1]?.toLowerCase() as "moderator" | "host" | undefined;
  const [name, org, ...title] = raw.replace(ROLE, "").split(",").map((part) => part.trim());
  if (!name) return null;
  return { name, org: org || null, title: title.join(", ") || null, role: role ?? "speaker" };
}

export interface ParsedSchedule {
  talks: TalkBody[];
  /** One per line that could not be read, naming the line. */
  errors: string[];
}

export function parseSchedule(text: string): ParsedSchedule {
  const talks: TalkBody[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "" || line.trim().startsWith("#")) return;
    const fields = line.split("|").map((f) => f.trim());
    const time = TIME.exec(fields[0] ?? "");
    if (time) fields.shift();
    const [title, speakers = "", kind = ""] = fields;
    const parsedKind = kind === "" ? "talk" : TalkKind.safeParse(kind.toLowerCase()).data;
    if (!title) return void errors.push(`line ${i + 1}: no title`);
    if (!parsedKind) return void errors.push(`line ${i + 1}: "${kind}" is not one of ${TalkKind.options.join(", ")}`);
    const parsed = TalkBody.safeParse({
      title,
      kind: parsedKind,
      starts_at: time?.[1] ?? null,
      ends_at: time?.[2] ?? null,
      speakers: speakers.split(";").map(parseSpeaker).filter((s) => s !== null),
    });
    if (!parsed.success) return void errors.push(`line ${i + 1}: ${parsed.error.issues[0]?.message ?? "not a talk"}`);
    talks.push(parsed.data);
  });
  return { talks, errors };
}

/** The same text back, so a schedule can be copied out, edited and pasted elsewhere. */
export function formatSchedule(talks: Talk[]): string {
  return talks
    .map((talk) => {
      const time = talk.starts_at ? `${talk.starts_at}${talk.ends_at ? `-${talk.ends_at}` : ""} | ` : "";
      const speakers = talk.speakers
        .map((s) => `${[s.name, s.org ?? (s.title ? "" : null), s.title].filter((part) => part !== null).join(", ")}${s.role === "speaker" ? "" : ` (${s.role})`}`)
        .join("; ");
      return `${time}${talk.title} | ${speakers} | ${talk.kind}`;
    })
    .join("\n");
}
