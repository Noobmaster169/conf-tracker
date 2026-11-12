import Link from "next/link";

import { clockText, dotClass, toneClass, tookText } from "@/lib/agents";
import type { RunSummary } from "@/lib/api-client";

/** An agent's runs, one line each: when, on which video, and what came of it. A line opens the call. */
export function CallList({ runs, hrefFor, now, empty }: { runs: RunSummary[]; hrefFor: (callId: number) => string; now: Date; empty: string }) {
  if (runs.length === 0) return <p className="px-1 py-6 text-ink-soft">{empty}</p>;
  return (
    <ul>
      {runs.map((run) => (
        <li key={run.id}>
          <Link href={hrefFor(run.id)} scroll={false} className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-sunk">
            <span className={`size-2 shrink-0 rounded-full ${dotClass(run.status)}`} />
            <span className="w-24 shrink-0 text-[13px] tabular-nums text-ink-soft">{clockText(run.created_at, now)}</span>
            <span className="hidden w-40 shrink-0 truncate text-[13px] text-ink-soft sm:block">{run.session_title ?? "Untitled video"}</span>
            <span className={`min-w-0 flex-1 truncate ${run.status === "ok" ? "" : toneClass(run.status)}`}>{run.result}
              {run.status === "slow" && ` · took ${tookText(run.latency_ms)}`}
            </span>
            <span aria-hidden className="text-ink-faint">›</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
