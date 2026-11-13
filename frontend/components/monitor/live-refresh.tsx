"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * While a stage is live, the page reads itself again every so often: the stage cards get the newest picture and what is
 * on stage now. The server answers from its shared cache (a window of seconds), so the box is asked once per window
 * however many people watch. A hidden tab does not refresh, and catches up as soon as it is shown again.
 */
export function LiveRefresh({ everyMs = 20_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && router.refresh();
    const timer = setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, everyMs]);
  return null;
}
