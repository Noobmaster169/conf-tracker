import type { Person } from "../contracts";

/** Deciding that a name heard on stage is a person already known, through the spellings speech recognition produces. */

const tokens = (name: string): string[] =>
  name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The same word, allowing one wrong letter in a word of five or more and two in one of nine or more. A short word must match exactly. */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const allowed = Math.min(a.length, b.length) >= 9 ? 2 : Math.min(a.length, b.length) >= 5 ? 1 : 0;
  return allowed > 0 && distance(a, b) <= allowed;
}

/**
 * The one person in `roster` this name means, or null. Every word heard must be one of the person's ("Anatoly" for
 * "Anatoly Yakovenko", "Anatoli Yakovenko" for the same), and when that fits more than one person nobody is chosen:
 * a wrong link puts one person's words under another's name.
 */
export function matchPerson<T extends Pick<Person, "name">>(name: string, roster: T[]): T | null {
  const heard = tokens(name);
  if (heard.length === 0) return null;
  const exact = roster.filter((p) => tokens(p.name).join(" ") === heard.join(" "));
  if (exact.length === 1) return exact[0]!;
  const fits = roster.filter((p) => {
    const known = tokens(p.name);
    return heard.every((h) => known.some((k) => sameWord(h, k)));
  });
  // A single first name is too weak to cross a spelling difference: "Jon" must not become "Joan".
  if (fits.length !== 1) return null;
  return heard.length > 1 || tokens(fits[0]!.name).includes(heard[0]!) ? fits[0]! : null;
}

/** "Co-Founder, Solana Labs" as the namer writes a role: the title, then the organisation after the last comma. */
export function splitRole(role: string | null): { title: string | null; org: string | null } {
  // Running a session is not a job title.
  if (!role || /^(moderator|mc|host)$/i.test(role.trim())) return { title: null, org: null };
  const at = role.lastIndexOf(", ");
  if (at === -1) return { title: role.trim() || null, org: null };
  return { title: role.slice(0, at).trim() || null, org: role.slice(at + 2).trim() || null };
}
