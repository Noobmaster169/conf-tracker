import type { ClaimHit, Lean, ShowFacet, TopicFacet } from "./api/claim-schemas";
import type { VideoTitle } from "./video-title";

export type LeanTone = "live" | "bad" | "dim";

/** A row's bar: its length is its count against the table's largest, its segments the directional split (none left out). */
export function leanBar(lean: Lean, count: number, max: number): { width: number; segments: { tone: LeanTone; share: number }[] } {
  const directional = lean.bullish + lean.bearish + lean.neutral;
  const parts: [LeanTone, number][] = [["live", lean.bullish], ["bad", lean.bearish], ["dim", lean.neutral]];
  return {
    width: max > 0 ? count / max : 0,
    segments: directional === 0 ? [] : parts.filter(([, n]) => n > 0).map(([tone, n]) => ({ tone, share: n / directional })),
  };
}

/** Raw model topics have a long tail; show the top repeated ones, fold the rest, and never hide an active filter. */
export function foldTopics(topics: TopicFacet[], active: string[], n = 8): { top: TopicFacet[]; more: TopicFacet[]; ones: TopicFacet[] } {
  const on = new Set(active.map((a) => a.toLowerCase()));
  const repeated = topics.filter((t) => t.count >= 2);
  const head = new Set(repeated.slice(0, n).map((t) => t.value));
  const top = topics.filter((t) => head.has(t.value) || on.has(t.value.toLowerCase()));
  const shown = new Set(top.map((t) => t.value));
  return {
    top,
    more: repeated.filter((t) => !shown.has(t.value)),
    ones: topics.filter((t) => t.count < 2 && !shown.has(t.value)),
  };
}

/** Stream time is only roughly video time on a live stream (ffmpeg starts partway into the live buffer), hence "~" in the UI. */
export function watchUrl(videoId: string | null, t0: number | null): string | null {
  if (!videoId || t0 === null) return null;
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(t0)}s`;
}

export function splitMatches(text: string, q: string): { text: string; hit: boolean }[] {
  if (!q) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

export function showLabel(show: Pick<ShowFacet, "video_id" | "source_file" | "session_id">, title?: VideoTitle | null): string {
  if (title) return title.title;
  if (show.video_id) return show.video_id;
  if (show.source_file) return show.source_file.slice(show.source_file.lastIndexOf("/") + 1);
  return show.session_id.slice(0, 8);
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const parts = (iso: string) => ({ month: MONTH.format(new Date(iso)), day: new Date(iso).getUTCDate() });

export function showDate(iso: string): string {
  const { month, day } = parts(iso);
  return `${month} ${day}`;
}

export function dateRange(shows: Pick<ShowFacet, "created_at">[]): string | null {
  if (shows.length === 0) return null;
  const sorted = shows.map((s) => s.created_at).sort();
  const first = parts(sorted[0]!);
  const last = parts(sorted.at(-1)!);
  if (first.month === last.month && first.day === last.day) return showDate(sorted[0]!);
  if (first.month === last.month) return `${first.month} ${first.day}–${last.day}`;
  return `${first.month} ${first.day} – ${last.month} ${last.day}`;
}

export function groupByShow(items: ClaimHit[]): { sessionId: string; items: ClaimHit[] }[] {
  const groups: { sessionId: string; items: ClaimHit[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.sessionId === item.session_id) last.items.push(item);
    else groups.push({ sessionId: item.session_id, items: [item] });
  }
  return groups;
}
