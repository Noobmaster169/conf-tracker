import Link from "next/link";

import type { ClaimHit, ShowFacet } from "@/lib/api/claim-schemas";
import { type ClaimFilters, claimsHref, set } from "@/lib/claim-filters";
import { groupByShow, showDate, splitMatches, watchUrl } from "@/lib/claim-view";
import { claimTime, polarityGlyph } from "@/lib/claims";
import { STATUS_ROW } from "@/components/session/claims-feed";
import type { VideoTitle } from "@/lib/video-title";

import { TONE_TEXT } from "./tones";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

type Props = {
  items: ClaimHit[];
  shows: ShowFacet[];
  labels: Record<string, string>;
  titles: Record<string, VideoTitle>;
  filters: ClaimFilters;
  onOpen: (claim: ClaimHit, row: HTMLElement) => void;
};

/** Claims under the show they came from, newest show first, each show read in stream order like show notes. */
export function ClaimList({ items, shows, labels, titles, filters, onOpen }: Props) {
  const byId = new Map(shows.map((show) => [show.session_id, show]));
  let index = 0;
  return (
    <div className="mt-6">
      {groupByShow(items).map((group) => {
        const show = byId.get(group.sessionId);
        const channel = show?.video_id ? titles[show.video_id]?.author : undefined;
        return (
          <section key={`${group.sessionId}:${group.items[0]!.id}`} aria-label={labels[group.sessionId]}>
            <header className="sticky top-0 z-10 -mx-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line bg-bg/95 px-4 py-2 backdrop-blur">
              <h2 className="min-w-0 truncate text-ink">{labels[group.sessionId] ?? group.sessionId.slice(0, 8)}</h2>
              <span className="text-xs text-ink-faint">
                {[channel, show && showDate(show.created_at), show && `${show.count} ${show.count === 1 ? "claim" : "claims"}`].filter(Boolean).join(" · ")}
              </span>
              <span className="ml-auto flex gap-4 text-xs">
                {!(filters.session.length === 1 && filters.session[0] === group.sessionId) && (
                  <Link href={claimsHref(set(filters, "session", [group.sessionId]))} className={`text-ink-dim hover:text-accent ${FOCUS}`}>
                    only this show
                  </Link>
                )}
                <Link href={`/session/${group.sessionId}`} className={`text-ink-dim hover:text-accent ${FOCUS}`}>
                  open session
                </Link>
              </span>
            </header>
            <ol>
              {group.items.map((claim) => (
                <ClaimRow key={claim.id} claim={claim} videoId={show?.video_id ?? null} q={filters.q} index={index++} onOpen={onOpen} />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function ClaimRow({ claim, videoId, q, index, onOpen }: { claim: ClaimHit; videoId: string | null; q: string; index: number; onOpen: Props["onOpen"] }) {
  const { glyph, label, tone } = polarityGlyph(claim.polarity);
  const watch = watchUrl(videoId, claim.t0);
  return (
    <li className={`grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 border-b border-line/50 py-3 sm:grid-cols-[5rem_minmax(0,1fr)_auto] ${STATUS_ROW[claim.status]}`}>
      <span className="pt-px text-xs tabular-nums text-ink-faint">{claimTime(claim)}</span>
      <button
        type="button"
        data-row-index={index}
        onClick={(event) => onOpen(claim, event.currentTarget)}
        className={`-mx-2 -my-1 min-w-0 rounded px-2 py-1 text-left hover:bg-panel ${FOCUS} focus:bg-panel`}
      >
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
          <span className={`text-sm ${TONE_TEXT[tone]}`} title={label}>
            <span aria-hidden>{glyph}</span>
            <span className="sr-only">{label}</span>
          </span>
          {claim.speaker.name ? (
            <span className="text-ink-dim">
              {claim.speaker.name}
              {claim.speaker.role && <span className="text-ink-faint"> · {claim.speaker.role}</span>}
            </span>
          ) : (
            <span className="text-ink-faint">{claim.speaker.id ?? "no speaker"}</span>
          )}
          {claim.topics.map((topic) => (
            <span key={topic} className="rounded border border-line px-1 text-ink-faint">
              <Marked text={topic} q={q} />
            </span>
          ))}
          {claim.status === "unverified" && <span className="text-warn">unverified</span>}
          {claim.status === "duplicate" && <span className="text-ink-faint">duplicate</span>}
        </span>
        <span className="mt-1.5 block leading-6 text-ink">
          <Marked text={claim.claim} q={q} />
        </span>
        <span className="mt-1.5 block border-l-2 border-line pl-3 text-xs leading-5 text-ink-dim">
          &ldquo;<Marked text={claim.quote} q={q} />&rdquo;
        </span>
      </button>
      {watch && (
        <a
          href={watch}
          target="_blank"
          rel="noreferrer"
          title="Open on YouTube near this moment. On a live stream the time can be off by tens of seconds."
          className={`col-start-2 mt-2 text-xs whitespace-nowrap text-ink-faint hover:text-accent sm:col-start-3 sm:mt-0 sm:pt-px ${FOCUS}`}
        >
          watch ~{claimTime(claim)} ↗
        </a>
      )}
    </li>
  );
}

function Marked({ text, q }: { text: string; q: string }) {
  return splitMatches(text, q).map((part, i) =>
    part.hit ? (
      <mark key={i} className="rounded-sm bg-accent/20 text-accent">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}
