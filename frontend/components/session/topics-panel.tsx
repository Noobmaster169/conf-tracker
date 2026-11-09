"use client";

import { useEffect, useState } from "react";

import type { Topics } from "@/lib/api/schemas";
import { fetchTopics } from "@/lib/api/topics";
import type { SessionState } from "@/lib/session-state";
import { topicsRange } from "@/lib/topics";

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; topics: Topics };

/** Topic counts for the last ten minutes, fetched again when the range moves or a claim lands. */
export function TopicsPanel({ state }: { state: SessionState }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const { from, to } = topicsRange(state.segments.at(-1)?.t1 ?? 0);
  const claimCount = state.claims.length;
  const sessionId = state.session.id;

  useEffect(() => {
    const controller = new AbortController();
    fetchTopics(sessionId, { from, to }, controller.signal).then(
      (topics) => setLoad({ kind: "ready", topics }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [sessionId, from, to, claimCount]);

  const rows = load.kind === "ready" ? load.topics.topics : [];
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section aria-label="Topics">
      <h2 className="sticky top-0 z-10 border-b border-line bg-bg px-3 py-1 text-ink-faint">topics, last 10 min</h2>
      {load.kind === "error" && (
        <p className="truncate px-3 py-1.5 text-bad" title={load.message}>
          {load.message}
        </p>
      )}
      {load.kind === "ready" && rows.length === 0 && <p className="px-3 py-1.5 text-ink-dim">No topics yet.</p>}
      <ul className="space-y-1 px-3 py-2">
        {rows.map((row) => (
          <li key={row.topic} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-ink-dim" title={row.topic}>
              {row.topic}
            </span>
            <span className="h-2 min-w-0 flex-1 rounded-sm bg-panel-raised">
              <span className="block h-full rounded-sm bg-accent/70" style={{ width: `${(row.count / max) * 100}%` }} />
            </span>
            <span className="w-6 shrink-0 text-right tabular-nums text-ink">{row.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
