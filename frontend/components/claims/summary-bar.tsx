import Link from "next/link";

import type { ClaimSearch } from "@/lib/api/claim-schemas";
import type { Polarity } from "@/lib/api/schemas";
import { type ClaimFilters, chips, claimsHref, EMPTY_FILTERS, isFiltered, set } from "@/lib/claim-filters";
import { dateRange } from "@/lib/claim-view";
import { polarityGlyph } from "@/lib/claims";

import { TONE_TEXT } from "./tones";

const LEAN: { label: string; polarity: Polarity | null }[] = [
  { label: "all", polarity: null },
  { label: "bullish", polarity: "bullish" },
  { label: "bearish", polarity: "bearish" },
  { label: "neutral", polarity: "neutral" },
];

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** How much is in view, which way it leans, and every filter that narrowed it, each one a click from gone. */
export function SummaryBar({ filters, data, labels }: { filters: ClaimFilters; data: ClaimSearch; labels: Record<string, string> }) {
  const range = dateRange(data.shows);
  const active = chips(filters, labels);
  const single = filters.polarity.length === 1 ? filters.polarity[0] : null;
  return (
    <div className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <p className="tabular-nums">
          <span className="text-lg text-ink">{data.total}</span>
          <span className="text-ink-dim"> {data.total === 1 ? "claim" : "claims"}</span>
          <span className="text-ink-faint">
            {" · "}
            {data.shows.length} {data.shows.length === 1 ? "show" : "shows"}
            {range && ` · ${range}`}
          </span>
        </p>
        <div role="group" aria-label="Lean" className="inline-flex overflow-hidden rounded border border-line">
          {LEAN.map(({ label, polarity }) => {
            const on = polarity === null ? filters.polarity.length === 0 : single === polarity;
            const glyph = polarity ? polarityGlyph(polarity) : null;
            // Counts are over the filtered set, so they only read true while no lean is chosen.
            const count = polarity && filters.polarity.length === 0 ? data.lean[polarity] : null;
            return (
              <Link
                key={label}
                href={claimsHref(set(filters, "polarity", polarity ? [polarity] : []))}
                aria-current={on ? "true" : undefined}
                title={label}
                className={`flex items-baseline gap-1.5 border-l border-line px-3 py-1 first:border-l-0 ${FOCUS} ${on ? "bg-panel-raised text-ink" : "text-ink-dim hover:bg-panel hover:text-ink"}`}
              >
                {glyph ? (
                  <span aria-hidden className={TONE_TEXT[glyph.tone]}>
                    {glyph.glyph}
                  </span>
                ) : (
                  <span>all</span>
                )}
                {/* The glyph is hidden, so its segment is named here; "all" already says so in plain text. */}
                {glyph && <span className="sr-only">{label} </span>}
                {count !== null && <span className="tabular-nums text-ink-faint">{count}</span>}
              </Link>
            );
          })}
        </div>
        <Link
          href={claimsHref({ ...filters, all: !filters.all })}
          className={`flex items-center gap-2 text-ink-dim hover:text-ink ${FOCUS}`}
        >
          <span aria-hidden className={`flex h-4 w-4 items-center justify-center rounded-sm border ${filters.all ? "border-accent text-accent" : "border-line"}`}>
            {filters.all ? "✓" : ""}
          </span>
          include unverified and duplicates
          <span className="sr-only">{filters.all ? " (on)" : " (off)"}</span>
        </Link>
      </div>
      {active.length > 0 && (
        <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2">
          {active.map((chip) => (
            <li key={`${chip.key}:${chip.value}`}>
              <Link
                href={chip.href}
                aria-label={`remove ${chip.label}`}
                className={`group flex items-center gap-2 rounded-full border border-line bg-panel py-0.5 pr-2 pl-3 text-xs text-ink hover:border-accent ${FOCUS}`}
              >
                {chip.label}
                <span aria-hidden className="text-ink-faint group-hover:text-accent">
                  ×
                </span>
              </Link>
            </li>
          ))}
          {isFiltered(filters) && (
            <li>
              <Link href={claimsHref({ ...EMPTY_FILTERS, all: filters.all })} className={`text-xs text-ink-faint hover:text-accent ${FOCUS}`}>
                clear all
              </Link>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
