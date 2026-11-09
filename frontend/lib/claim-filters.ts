import { z } from "zod";

import { Polarity } from "./api/schemas";

/** The filters of the claims explorer, as the URL carries them. The backend's GET /claims takes the same keys. */
export const UNNAMED = "(unnamed)";

export type FilterKey = "topic" | "speaker" | "polarity" | "session";
export interface ClaimFilters {
  q: string;
  topic: string[];
  speaker: string[];
  polarity: Polarity[];
  session: string[];
  all: boolean;
}

export const EMPTY_FILTERS: ClaimFilters = { q: "", topic: [], speaker: [], polarity: [], session: [], all: false };

const UUID = z.uuid();
/** The backend refuses a longer q (backend/src/contracts.ts ClaimSearchQuery). */
export const Q_MAX = 200;
const KEEP: Record<FilterKey, (v: string) => boolean> = {
  topic: (v) => v.length > 0,
  speaker: (v) => v.length > 0,
  polarity: (v) => Polarity.safeParse(v).success,
  session: (v) => UUID.safeParse(v).success,
};

const values = (raw: string | string[] | undefined): string[] => (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).map((v) => v.trim());
/** The backend lower-cases topic facets and matches topics case-insensitively, so filter state holds them lower-case too. */
const norm = (key: FilterKey, v: string): string => (key === "topic" ? v.toLowerCase() : v);
const clean = (key: FilterKey, raw: string[]): string[] => [...new Set(raw.map((v) => norm(key, v)).filter(KEEP[key]))];

/** Lenient on purpose: a hand-edited URL with a bad value renders without that value instead of failing the page. */
export function parseFilters(sp: Record<string, string | string[] | undefined>): ClaimFilters {
  return {
    q: (values(sp.q)[0] ?? "").slice(0, Q_MAX),
    topic: clean("topic", values(sp.topic)),
    speaker: clean("speaker", values(sp.speaker)),
    polarity: clean("polarity", values(sp.polarity)) as Polarity[],
    session: clean("session", values(sp.session)),
    all: values(sp.all)[0] === "1",
  };
}

export function toQuery(f: ClaimFilters, page: { offset?: number; limit?: number; as_of?: number | null } = {}): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  for (const key of ["topic", "speaker", "polarity", "session"] as const) for (const v of f[key]) params.append(key, v);
  if (f.all) params.set("all", "1");
  if (page.offset !== undefined) params.set("offset", String(page.offset));
  if (page.limit !== undefined) params.set("limit", String(page.limit));
  if (page.as_of !== undefined && page.as_of !== null) params.set("as_of", String(page.as_of));
  return params.toString();
}

export function claimsHref(f: ClaimFilters): string {
  const query = toQuery(f);
  return query ? `/claims?${query}` : "/claims";
}

export function toggle(f: ClaimFilters, key: FilterKey, value: string): ClaimFilters {
  const current = f[key] as string[];
  const v = norm(key, value);
  return set(f, key, current.includes(v) ? current.filter((c) => c !== v) : [...current, v]);
}

export function set(f: ClaimFilters, key: FilterKey, next: string[]): ClaimFilters {
  return { ...f, [key]: clean(key, next) };
}

/** Whether anything narrows the set; `all` widens it, so it does not count. */
export function isFiltered(f: ClaimFilters): boolean {
  return f.q !== "" || f.topic.length > 0 || f.speaker.length > 0 || f.polarity.length > 0 || f.session.length > 0;
}

export interface Chip {
  key: FilterKey | "q";
  value: string;
  label: string;
  href: string;
}

/** One chip per active value, each linking to the same view without it. `shows` names sessions by their title. */
export function chips(f: ClaimFilters, shows: Record<string, string> = {}): Chip[] {
  const out: Chip[] = [];
  if (f.q) out.push({ key: "q", value: f.q, label: `“${f.q}”`, href: claimsHref({ ...f, q: "" }) });
  const label: Record<FilterKey, (v: string) => string> = {
    topic: (v) => `topic: ${v}`,
    speaker: (v) => `speaker: ${v === UNNAMED ? "unnamed" : v}`,
    polarity: (v) => `lean: ${v}`,
    session: (v) => `show: ${shows[v] ?? v.slice(0, 8)}`,
  };
  for (const key of ["topic", "speaker", "polarity", "session"] as const) {
    for (const v of f[key]) out.push({ key, value: v, label: label[key](v), href: claimsHref(toggle(f, key, v)) });
  }
  return out;
}
