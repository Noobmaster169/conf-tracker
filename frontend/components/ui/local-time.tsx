"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/**
 * A moment in the reader's own time zone. The server does not know that zone, so it renders nothing and the browser
 * fills it in; the page never shows a time that is right somewhere else.
 */
export function LocalTime({ iso, mode = "time" }: { iso: string; mode?: "time" | "date" | "both" }) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  if (!mounted) return <time dateTime={iso} />;
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString([], { day: "numeric", month: "short" });
  return <time dateTime={iso}>{mode === "time" ? time : mode === "date" ? day : `${day}, ${time}`}</time>;
}
