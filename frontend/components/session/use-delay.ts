"use client";

import { useSyncExternalStore } from "react";

const KEY = "conf-tracker:transcript-delay-s";
export const MAX_DELAY_S = 60;

// One value per page, read from storage once. An external store, because the server renders 0 and the browser may know better.
let current: number | null = null;
const listeners = new Set<() => void>();

function load(): number {
  try {
    const stored = Number(window.localStorage.getItem(KEY));
    return Number.isInteger(stored) && stored >= 0 && stored <= MAX_DELAY_S ? stored : 0;
  } catch (error) {
    console.warn("transcript delay not restored", error);
    return 0;
  }
}

function snapshot(): number {
  if (current === null) current = load();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function update(value: number): void {
  current = value;
  try {
    window.localStorage.setItem(KEY, String(value));
  } catch (error) {
    // Storage can be missing or refuse (a private window); the slider still works for this page.
    console.warn("transcript delay not saved", error);
  }
  for (const listener of listeners) listener();
}

/** The transcript delay in seconds, remembered per browser. */
export function useDelay(): [number, (value: number) => void] {
  return [useSyncExternalStore(subscribe, snapshot, () => 0), update];
}
