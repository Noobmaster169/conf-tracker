"use client";

import { useEffect, useState } from "react";

import type { SpeakerDetail } from "@/lib/api/schemas";
import { fetchSpeakerDetail } from "@/lib/api/speaker-detail";
import { formatT } from "@/lib/format";
import { speakerColor } from "@/lib/speaker-color";
import { detailRows } from "@/lib/speaker-detail";

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; detail: SpeakerDetail };

/** The names proposed for one speaker and its last windows' match scores, fetched once when the row opens. A proposal opens the call behind it. */
export function SpeakerDetailView({ sessionId, speakerId, onOpenCall }: { sessionId: string; speakerId: string; onOpenCall: (callId: number) => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchSpeakerDetail(sessionId, speakerId, controller.signal).then(
      (detail) => setLoad({ kind: "ready", detail }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [sessionId, speakerId, attempt]);

  if (load.kind === "loading") return <p className="px-3 py-1.5 text-ink-faint">Loading windows...</p>;
  if (load.kind === "error") {
    return (
      <p className="flex items-center gap-3 px-3 py-1.5 text-bad">
        <span className="min-w-0 truncate">{load.message}</span>
        <button
          type="button"
          onClick={() => {
            setLoad({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
          className="shrink-0 rounded border border-line px-2 text-ink-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          Retry
        </button>
      </p>
    );
  }

  const rows = detailRows(load.detail, speakerId);
  const { proposals } = load.detail;
  const proposalList = proposals.length > 0 && (
    <ul className="divide-y divide-line/60 border-b border-line/60 text-xs">
      {proposals.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onOpenCall(p.call_id)}
            className="block w-full px-3 py-1 text-left hover:bg-panel-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <span className="tabular-nums text-ink-dim">{p.confidence.toFixed(2)}</span>{" "}
            <span className={p.status === "accepted" ? "text-ink" : "text-ink-dim"}>{p.name}</span>{" "}
            <span className={p.status === "accepted" ? "text-live" : "text-warn"}>{p.status}</span>
            {p.reason && <span className="text-ink-faint"> ({p.reason})</span>}
            <span className="block text-ink-faint">&quot;{p.quote}&quot;</span>
          </button>
        </li>
      ))}
    </ul>
  );
  if (rows.length === 0) {
    return (
      <>
        {proposalList}
        <p className="px-3 py-1.5 text-ink-faint">No windows recorded for {speakerId} yet.</p>
      </>
    );
  }
  return (
    <>
      {proposalList}
      <table   className="w-full text-xs tabular-nums">
        <thead className="text-left text-ink-faint">
          <tr>
            <th className="px-3 py-1 font-normal">window</th>
            <th className="px-2 py-1 font-normal">match</th>
            <th className="px-2 py-1 font-normal">scores</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.windowId} className="border-t border-line/60 align-top">
              <td className="whitespace-nowrap px-3 py-1 text-ink-dim">
                {formatT(row.t0)}–{formatT(row.t1)}
              </td>
              <td className="whitespace-nowrap px-2 py-1 text-ink-dim">
                {row.match ? (
                  <>
                    {row.match.local} {row.match.speech_s.toFixed(1)}s{row.match.new && <span className="ml-1 text-accent">new</span>}
                  </>
                ) : (
                  <span className="text-ink-faint">--</span>
                )}
              </td>
              <td className="px-2 py-1">
                <span className="flex flex-wrap gap-x-3">
                  {row.scores.map((cell) => (
                    <span key={cell.id} className={cell.own ? "text-ink" : "text-ink-dim"}>
                      <span style={{ color: speakerColor(cell.id) }}>{cell.id}</span> {cell.score.toFixed(2)}
                    </span>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
