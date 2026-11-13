"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

// The first page this tab showed, and whether the reader has since moved to another: then Back stays inside the app.
// Kept as a fact rather than a count, so an effect run twice (React's dev mode) changes nothing.
let firstPath: string | null = null;
let moved = false;

/** Notes each page the app shows; the bar calls it, so it runs on every page. */
export function useTrackPages() {
  const path = usePathname();
  useEffect(() => {
    if (firstPath === null) firstPath = path;
    else if (path !== firstPath) moved = true;
  }, [path]);
}

/**
 * Back to the page the reader came from, as the browser's Back would. A page opened straight from a link has nowhere
 * in the app to go back to, so it goes to `fallback`, the list the page belongs to.
 */
export function BackButton({ fallback }: { fallback: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => (moved ? router.back() : router.push(fallback))}
      className="-ml-2 mb-4 inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-[14px] font-medium text-ink-soft hover:bg-sunk hover:text-ink"
    >
      <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Back
    </button>
  );
}
