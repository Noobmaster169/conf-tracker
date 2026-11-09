"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { type ClaimFilters, claimsHref, Q_MAX } from "@/lib/claim-filters";

export const SEARCH_ID = "claims-search";

/**
 * Typing replaces the URL's q after a pause. The URL can also change under the box (a chip removed, a link followed);
 * then the box takes the URL's value, unless that value is the one it just sent, so keys typed since are kept.
 */
export function SearchBox({ filters }: { filters: ClaimFilters }) {
  const router = useRouter();
  const [value, setValue] = useState(filters.q);
  const [synced, setSynced] = useState(filters.q);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (filters.q !== synced) {
    setSynced(filters.q);
    if (filters.q !== sent) setValue(filters.q);
    setSent(null);
  }

  useEffect(() => {
    // Sliced like parseFilters slices the URL's q, or a longer value would never match and would re-send forever.
    const q = value.trim().slice(0, Q_MAX);
    if (q === filters.q) return;
    const timer = setTimeout(() => {
      setSent(q);
      startTransition(() => router.replace(claimsHref({ ...filters, q }), { scroll: false }));
    }, 300);
    return () => clearTimeout(timer);
  }, [value, filters, router]);

  return (
    <div className="relative">
      <kbd aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 rounded border border-line px-1 text-xs text-ink-faint">
        /
      </kbd>
      <input
        id={SEARCH_ID}
        type="search"
        maxLength={Q_MAX}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        placeholder="search claims, quotes and topics"
        aria-label="Search claims, quotes and topics"
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded border border-line bg-panel py-2 pr-10 pl-10 text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      {pending && <span className="absolute top-1/2 right-3 -translate-y-1/2 animate-pulse text-ink-faint">···</span>}
    </div>
  );
}
