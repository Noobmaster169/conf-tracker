/** Stream seconds as mm:ss, or h:mm:ss past an hour. */
export function formatT(seconds: number): string {
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** How long something ran, in words a card can carry: "42 min", "3 h 05 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A schedule's day ("2026-11-10") as "Tue, 10 Nov 2026". Built from the parts, so no time zone can move it. */
export function formatDay(day: string | null): string | null {
  const match = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** A talk's planned time as printed: "10:00 to 10:30", "10:00", or nothing. */
export function plannedTime(startsAt: string | null, endsAt: string | null): string | null {
  if (!startsAt) return null;
  return endsAt ? `${startsAt} to ${endsAt}` : startsAt;
}

/** "Co-Founder, Solana Labs" from whichever of the two is known. */
export function titleAndOrg(person: { title: string | null; org: string | null }): string | null {
  return [person.title, person.org].filter(Boolean).join(", ") || null;
}

/** The still YouTube keeps for every video. It is letterboxed 4:3, so it is shown cropped to 16:9. */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/** One or two initials for a face with no photo. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** A steady hue per name, so a person without a photo keeps one colour everywhere. */
export function nameHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A session's description as worth reading, or null. The event's schedule opens many with the session's format
 * ("Product Keynote.", "Remarks.", "Open/Close."), which the page already says; that label goes, and what is left
 * shows only when it is a sentence, not an emoji or nothing.
 */
export function readableDescription(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  const label = /^([^.!?]+)\.\s*/.exec(trimmed);
  const words = label?.[1].trim().split(/\s+/) ?? [];
  // A label is a few capitalised words ("Product Keynote"); a sentence of three ("Tokenisation is easy") is not.
  const isLabel = words.length > 0 && words.length <= 3 && words.every((w) => /^\p{Lu}/u.test(w));
  const rest = label && isLabel ? trimmed.slice(label[0].length) : trimmed;
  return (rest.match(/\p{L}/gu)?.length ?? 0) >= 12 ? rest : null;
}
