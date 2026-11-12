import Link from "next/link";

import { clockText, dotClass, toneClass, tookText } from "@/lib/agents";
import type { RunSummary } from "@/lib/api-client";

/**
 * An agent's runs as a table across the panel: when, on which video, what came of it, how long it took and what it
 * ran with. A line opens the call.
 */
export function CallList({ runs, hrefFor, now, empty }: { runs: RunSummary[]; hrefFor: (callId: number) => string; now: Date; empty: string }) {
  if (runs.length === 0) return <p className="px-1 py-6 text-ink-soft">{empty}</p>;
  const cols = "grid grid-cols-[auto_5.5rem_minmax(0,1fr)_auto] items-center gap-x-3 md:grid-cols-[auto_6rem_minmax(0,13rem)_minmax(0,1fr)_4.5rem_6.5rem_auto]";
  return (
    <div>
      <div className={`${cols} hidden border-b border-line px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-ink-soft md:grid`}>
        <span className="size-2" />
        <span>When</span>
        <span>Video</span>
        <span>What came of it</span>
        <span className="text-right">Took</span>
        <span>Ran with</span>
        <span className="w-2" />
      </div>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <Link href={hrefFor(run.id)} scroll={false} className={`${cols} min-h-10 rounded-lg px-3 py-1.5 transition-colors hover:bg-sunk`}>
              <span className={`size-2 rounded-full ${dotClass(run.status)}`} />
              <span className="text-[13px] tabular-nums text-ink-soft">{clockText(run.created_at, now)}</span>
              <span className="hidden min-w-0 break-words text-[13px] text-ink-soft md:block">{run.session_title ?? "Untitled video"}</span>
              <span className={`min-w-0 break-words ${run.status === "ok" ? "" : toneClass(run.status)}`}>{run.result}</span>
              <span className={`hidden text-right text-[13px] tabular-nums md:block ${run.status === "slow" ? toneClass("slow") : "text-ink-soft"}`}>{tookText(run.latency_ms)}</span>
              <span className="hidden text-[13px] text-ink-soft md:block">
                {run.prompt_version} · {run.model.replace(/^claude-/, "").slice(0, 14)}
              </span>
              <span aria-hidden className="text-ink-faint">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
