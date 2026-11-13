"use client";

import { useEffect, useRef, useState } from "react";

import { ClaimCard } from "@/components/ui/claim-card";
import { Empty } from "@/components/ui/bits";
import { LocalTime } from "@/components/ui/local-time";
import type { ClaimKind } from "@/lib/api/schemas";
import { Feed, type FeedItem } from "@/lib/api/views";
import { KINDS } from "@/lib/kinds";

const POLL_MS = 5000;

type Filter = { kind: ClaimKind | null; major: boolean };

function query(scope: Record<string, string>, filter: Filter, extra: Record<string, number>): string {
  const params = new URLSearchParams(scope);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.major) params.set("min_importance", "4");
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params.toString();
}

async function load(scope: Record<string, string>, filter: Filter, extra: Record<string, number>): Promise<Feed> {
  const response = await fetch(`/api/feed?${query(scope, filter, extra)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`The feed answered ${response.status}`);
  return Feed.parse(await response.json());
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-full border px-3 py-1 text-sm font-medium ${active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:text-ink"}`}>
      {children}
    </button>
  );
}

/**
 * The claims of one day, of every stage or of one, newest on top. While the day has a live stage it checks for more every
 * few seconds; a day that has ended asks nothing more. The page keys it by its scope, so a new day or stage starts it afresh.
 */
export function MonitorFeed({ initial, scope, live }: { initial: Feed; scope: Record<string, string>; live: boolean }) {
  const [filter, setFilter] = useState<Filter>({ kind: null, major: false });
  const [items, setItems] = useState<FeedItem[]>(initial.items);
  const [older, setOlder] = useState<number | null>(initial.next_before);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The first render already holds the unfiltered page, so only a changed filter reloads.
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let stale = false;
    load(scope, filter, {})
      .then((feed) => {
        if (stale) return;
        setItems(feed.items);
        setOlder(feed.next_before);
        setError(null);
      })
      .catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
    // The scope is fixed for the component's life (the page keys it), so only the filter moves this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const newest = items[0]?.id ?? 0;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      load(scope, filter, { after: newest })
        .then((feed) => {
          setError(null);
          if (feed.items.length > 0) setItems((current) => [...feed.items.filter((item) => !current.some((c) => c.id === item.id)), ...current]);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, newest, live]);

  const more = async () => {
    if (older === null) return;
    setBusy(true);
    try {
      const feed = await load(scope, filter, { before: older });
      setItems((current) => [...current, ...feed.items]);
      setOlder(feed.next_before);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Chip active={filter.kind === null} onClick={() => setFilter({ ...filter, kind: null })}>
          Everything
        </Chip>
        {KINDS.map(({ kind, plural }) => (
          <Chip key={kind} active={filter.kind === kind} onClick={() => setFilter({ ...filter, kind })}>
            {plural}
          </Chip>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={filter.major} onChange={(event) => setFilter({ ...filter, major: event.target.checked })} className="size-4 accent-accent" />
          Major only
        </label>
      </div>
      {error && <p className="mb-4 rounded-lg bg-live-soft px-3 py-2 text-sm text-live">Could not refresh: {error}. Trying again.</p>}
      {items.length === 0 ? (
        <Empty>{live ? "Nothing has been said yet that fits. Claims appear here within a minute of being spoken on stage." : "No claims that fit."}</Empty>
      ) : (
        <ol className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <ClaimCard item={item} aside={<LocalTime iso={item.created_at} />} />
            </li>
          ))}
        </ol>
      )}
      {older !== null && (
        <div className="mt-6 text-center">
          <button type="button" onClick={more} disabled={busy} className="btn btn-quiet">
            {busy ? "Loading" : "Show older claims"}
          </button>
        </div>
      )}
    </>
  );
}
