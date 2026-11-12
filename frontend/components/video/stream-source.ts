import type { Relay } from "@/lib/relay-ticket";

/** How long the relay gets to open, or to come back after a drop, before the page streams through Vercel instead. */
export const STALL_MS = 10_000;

export type Source = "relay" | "vercel";

export function streamUrl(sessionId: string, after: number, relay: Relay | null, source: Source): string {
  const id = encodeURIComponent(sessionId);
  if (relay && source === "relay") return `${relay.url}/sessions/${id}/events?after=${after}&ticket=${encodeURIComponent(relay.ticket)}`;
  return `/api/sessions/${id}/events?after=${after}`;
}

/**
 * Watches a stream on the relay and calls `fallBack` once: when the relay refuses (the EventSource is CLOSED), or
 * when it has not opened within STALL_MS of starting or of a drop. The page never moves back to the relay, so a
 * flapping relay cannot bounce it.
 */
export function relayWatch(fallBack: () => void): { started(): void; opened(): void; errored(closed: boolean): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    if (done) return;
    done = true;
    clear();
    fallBack();
  };
  const arm = () => {
    if (done || timer) return;
    timer = setTimeout(fire, STALL_MS);
  };
  return {
    started: arm,
    opened: clear,
    errored: (closed) => (closed ? fire() : arm()),
    stop: () => {
      done = true;
      clear();
    },
  };
}
