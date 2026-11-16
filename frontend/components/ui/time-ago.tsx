"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { timeAgo } from "@/lib/format";

const noop = () => () => {};

/**
 * "2 min ago", kept current while the page is open. The server renders nothing, so the reader never sees an age worked
 * out on another clock; past a week it says nothing at all.
 */
export function TimeAgo({ iso }: { iso: string }) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const text = mounted ? timeAgo(iso, now) : null;
  return text ? <time dateTime={iso}>{text}</time> : null;
}
