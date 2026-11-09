"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";

import type { Lean, SpeakerFacet, TopicFacet } from "@/lib/api/claim-schemas";
import type { Polarity } from "@/lib/api/schemas";
import { type ClaimFilters, claimsHref, type FilterKey, set, toggle, UNNAMED } from "@/lib/claim-filters";
import { foldTopics, leanBar } from "@/lib/claim-view";
import { polarityGlyph } from "@/lib/claims";

import { TONE_BG, TONE_TEXT } from "./tones";

const FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
const DIRECTIONS: Polarity[] = ["bullish", "bearish", "neutral"];
const SPEAKERS_SHOWN = 8;

interface Row {
  value: string;
  label: ReactNode;
  count: number;
  lean: Lean;
  aside: string;
}

/** Topics as the model tagged them: the repeated ones first, the long tail folded away until asked for. */
export function TopicsTable({ filters, topics }: { filters: ClaimFilters; topics: TopicFacet[] }) {
  const folded = foldTopics(topics, filters.topic);
  const rows = (list: TopicFacet[]): Row[] => list.map((t) => ({ value: t.value, label: t.value, count: t.count, lean: t.lean, aside: t.voices.join(", ") }));
  return (
    <Table title="topics" total={topics.length} filters={filters} filterKey="topic" max={topics[0]?.count ?? 0}
      rows={rows(folded.top)} more={rows(folded.more)} ones={rows(folded.ones)} empty="No topics in view." />
  );
}

/** Named speakers across every show, joined by name; everyone never named is one "unnamed" row. */
export function SpeakersTable({ filters, speakers }: { filters: ClaimFilters; speakers: SpeakerFacet[] }) {
  const rows: Row[] = speakers.map((s) => ({
    value: s.name ?? UNNAMED,
    label: s.name ?? <span className="text-ink-faint">unnamed</span>,
    count: s.count,
    lean: s.lean,
    aside: s.topics.join(", "),
  }));
  const on = new Set(filters.speaker);
  const top = rows.filter((r, i) => i < SPEAKERS_SHOWN || on.has(r.value));
  const more = rows.filter((r, i) => i >= SPEAKERS_SHOWN && !on.has(r.value));
  return (
    <Table title="speakers" total={speakers.length} filters={filters} filterKey="speaker" max={speakers[0]?.count ?? 0}
      rows={top} more={more} ones={[]} empty="No speakers in view." />
  );
}

interface TableProps {
  title: string;
  total: number;
  filters: ClaimFilters;
  filterKey: Extract<FilterKey, "topic" | "speaker">;
  max: number;
  rows: Row[];
  more: Row[];
  ones: Row[];
  empty: string;
}

function Table({ title, total, filters, filterKey, max, rows, more, ones, empty }: TableProps) {
  const [open, setOpen] = useState({ more: false, ones: false });
  const shown = [...rows, ...(open.more ? more : []), ...(open.ones ? ones : [])];
  return (
    <section aria-label={title} className="min-w-0 rounded border border-line bg-panel">
      <h2 className="flex items-baseline justify-between border-b border-line px-3 py-2 text-xs tracking-wider text-ink-faint uppercase">
        {title}
        <span className="tabular-nums normal-case">{total}</span>
      </h2>
      {shown.length === 0 ? (
        <p className="px-3 py-3 text-ink-dim">{empty}</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {shown.map((row) => (
            <FacetRow key={row.value} row={row} max={max} filters={filters} filterKey={filterKey} />
          ))}
        </ul>
      )}
      {((more.length > 0 && !open.more) || (ones.length > 0 && !open.ones)) && (
        <div className="flex gap-4 border-t border-line px-3 py-2 text-xs">
          {more.length > 0 && !open.more && (
            <button type="button" onClick={() => setOpen((o) => ({ ...o, more: true }))} className={`text-ink-dim hover:text-accent ${FOCUS}`}>
              + {more.length} more
            </button>
          )}
          {ones.length > 0 && !open.ones && (
            <button type="button" onClick={() => setOpen((o) => ({ ...o, ones: true }))} className={`text-ink-faint hover:text-accent ${FOCUS}`}>
              + {ones.length} with one claim
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function FacetRow({ row, max, filters, filterKey }: { row: Row; max: number; filters: ClaimFilters; filterKey: TableProps["filterKey"] }) {
  const active = (filters[filterKey] as string[]).includes(row.value);
  const bar = leanBar(row.lean, row.count, max);
  // A lean count narrows to this row and that lean together, keeping the row if it is already on.
  const withLean = (polarity: Polarity) => {
    const base = active ? filters : toggle(filters, filterKey, row.value);
    return claimsHref(set(base, "polarity", [polarity]));
  };
  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_2.5rem_8.5rem] items-center gap-x-3 border-l-2 px-3 py-1.5 sm:grid-cols-[minmax(6rem,1fr)_2.5rem_8.5rem_4rem_minmax(0,1fr)] ${active ? "border-accent bg-panel-raised" : "border-transparent hover:bg-panel-raised"}`}
    >
      <Link
        href={claimsHref(toggle(filters, filterKey, row.value))}
        aria-current={active ? "true" : undefined}
        title={active ? "remove this filter" : "show only these claims"}
        className={`truncate ${FOCUS} ${active ? "text-accent" : "text-ink hover:text-accent"}`}
      >
        {row.label}
      </Link>
      <span className="text-right tabular-nums text-ink">{row.count}</span>
      <span className="flex gap-2 tabular-nums">
        {DIRECTIONS.map((polarity) => {
          const n = row.lean[polarity];
          const { glyph, tone } = polarityGlyph(polarity);
          return n === 0 ? (
            <span key={polarity} className="w-9 text-ink-faint/50">
              {glyph}
            </span>
          ) : (
            <Link key={polarity} href={withLean(polarity)} title={`${n} ${polarity}`} className={`w-9 hover:underline ${TONE_TEXT[tone]} ${FOCUS}`}>
              <span aria-hidden>{glyph}</span>
              <span className="sr-only">{polarity} </span>
              {n}
            </Link>
          );
        })}
      </span>
      <span aria-hidden className="hidden h-1.5 rounded-full bg-bg sm:block">
        <span className="flex h-full overflow-hidden rounded-full" style={{ width: `${Math.max(bar.width * 100, 4)}%` }}>
          {bar.segments.length === 0 ? (
            <span className="w-full bg-ink-faint" />
          ) : (
            bar.segments.map((s) => <span key={s.tone} className={TONE_BG[s.tone]} style={{ width: `${s.share * 100}%` }} />)
          )}
        </span>
      </span>
      <span className="hidden truncate text-xs text-ink-faint sm:block" title={row.aside}>
        {row.aside}
      </span>
    </li>
  );
}
