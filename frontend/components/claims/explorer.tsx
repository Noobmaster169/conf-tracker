"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { AuditDrawer } from "@/components/session/audit-drawer";
import { fetchClaimPage } from "@/lib/api/claim-search";
import type { ClaimHit, ClaimSearch } from "@/lib/api/claim-schemas";
import { type ClaimFilters, claimsHref, EMPTY_FILTERS, isFiltered, toQuery } from "@/lib/claim-filters";
import { showLabel } from "@/lib/claim-view";
import type { VideoTitle } from "@/lib/video-title";

import { ClaimList } from "./claim-list";
import { SpeakersTable, TopicsTable } from "./facet-table";
import { SEARCH_ID } from "./search-box";
import { SummaryBar } from "./summary-bar";

const PAGE = 200;

type Props = { filters: ClaimFilters; data: ClaimSearch; titles: Record<string, VideoTitle> };
type More = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

/** One filtered view. Keyed on its query by the page, so a new filter starts it fresh rather than mixing pages. */
export function Explorer({ filters, data, titles }: Props) {
  const [items, setItems] = useState(data.items);
  const [next, setNext] = useState(data.next_offset);
  const [speakers, setSpeakers] = useState(data.session_speakers);
  const [more, setMore] = useState<More>({ kind: "idle" });
  const [open, setOpen] = useState<ClaimHit | null>(null);
  // The row a drawer was opened from. The drawer unmounts on close and focus would fall to body, so it goes back here.
  const opener = useRef<HTMLElement | null>(null);
  const labels = useMemo(
    () => Object.fromEntries(data.shows.map((show) => [show.session_id, showLabel(show, show.video_id ? titles[show.video_id] : null)])),
    [data.shows, titles],
  );

  useKeyboard(open !== null);

  function openClaim(claim: ClaimHit, row: HTMLElement) {
    opener.current = row;
    setOpen(claim);
  }

  function closeClaim() {
    setOpen(null);
    const row = opener.current;
    opener.current = null;
    requestAnimationFrame(() => {
      if (row?.isConnected) row.focus();
    });
  }

  async function loadMore() {
    if (next === null) return;
    setMore({ kind: "loading" });
    try {
      // as_of pins the set to the first page's, so claims arriving meanwhile shift nothing.
      const page = await fetchClaimPage(toQuery(filters, { offset: next, limit: PAGE, as_of: data.as_of }), AbortSignal.timeout(20_000));
      setItems((prev) => [...prev, ...page.items]);
      setSpeakers((prev) => ({ ...prev, ...page.session_speakers }));
      setNext(page.next_offset);
      setMore({ kind: "idle" });
    } catch (error) {
      setMore({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  // Only when nothing at all is stored; with `all` off, unverified claims may exist and the toggle must stay in reach.
  if (data.total === 0 && !isFiltered(filters) && filters.all) {
    return (
      <p className="py-10 text-ink-dim">
        No claims yet. Start a session from the{" "}
        <Link href="/" className="text-accent hover:underline">
          sessions page
        </Link>{" "}
        and they will gather here.
      </p>
    );
  }

  return (
    <>
      <SummaryBar filters={filters} data={data} labels={labels} />
      <div className="grid gap-4 lg:grid-cols-2">
        <TopicsTable filters={filters} topics={data.topics} />
        <SpeakersTable filters={filters} speakers={data.speakers} />
      </div>
      {data.total === 0 ? (
        <p className="py-10 text-center text-ink-dim">
          No claims match.{" "}
          <Link href={claimsHref({ ...EMPTY_FILTERS, all: filters.all })} className="text-accent hover:underline">
            Clear filters
          </Link>
        </p>
      ) : (
        <ClaimList items={items} shows={data.shows} labels={labels} titles={titles} filters={filters} onOpen={openClaim} />
      )}
      {next !== null && (
        <div className="mt-6 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={more.kind === "loading"}
            className="rounded border border-line px-4 py-2 text-ink-dim hover:border-ink-faint hover:text-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {more.kind === "loading" ? "loading…" : `load more · ${data.total - items.length} left`}
          </button>
          {more.kind === "error" && <p className="text-bad">{more.message}</p>}
        </div>
      )}
      <p className="mt-8 hidden text-center text-xs text-ink-faint sm:block">
        <kbd>/</kbd> search · <kbd>j</kbd> <kbd>k</kbd> move · <kbd>enter</kbd> open the call · <kbd>esc</kbd> close
      </p>
      <AuditDrawer
        target={open && { callId: open.call_id, claimId: open.id }}
        speakers={open ? (speakers[open.session_id] ?? []) : []}
        onClose={closeClaim}
      />
    </>
  );
}

/** `/` jumps to search; j and k walk the rows, whose buttons then open on Enter like any button. Off while the drawer is open. */
function useKeyboard(drawerOpen: boolean) {
  useEffect(() => {
    if (drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (event.key === "/") {
        event.preventDefault();
        const search = document.getElementById(SEARCH_ID);
        search?.focus();
        search?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key !== "j" && event.key !== "k") return;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-row-index]")];
      if (rows.length === 0) return;
      const current = rows.indexOf(document.activeElement as HTMLElement);
      const to = current === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, current + (event.key === "j" ? 1 : -1)));
      event.preventDefault();
      rows[to]!.focus();
      rows[to]!.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
}
