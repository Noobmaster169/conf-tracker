import Link from "next/link";

import { stopSessionAction } from "@/app/actions/sessions";
import { formatT, shortModel, wallTime } from "@/lib/format";
import type { SessionState } from "@/lib/session-state";
import { formatCost, lastCallOf, proxyState } from "@/lib/status";

const STATUS_COLOR: Record<SessionState["session"]["status"], string> = {
  starting: "text-warn",
  live: "text-live",
  degraded: "text-bad",
  stopped: "text-ink-dim",
};

export function StatusBar({ state }: { state: SessionState }) {
  const { session, health, connection } = state;
  const last = state.segments.at(-1);
  const diarModel = shortModel(session.models.diarization);
  const extract = lastCallOf(state.calls, "extract");
  const proxy = proxyState(state.calls);
  return (
    <footer className={`flex flex-wrap items-center gap-x-6 gap-y-1 bg-panel px-4 py-2 ${session.status === "degraded" ? "border-t border-bad" : ""}`}>
      <span className={STATUS_COLOR[session.status]}>● {session.status}</span>
      {session.error && <span className="text-bad truncate">{session.error}</span>}
      <span className="text-ink-dim">t {last ? formatT(last.t1) : "--:--"}</span>
      <span className="text-ink-dim">lag {health ? `${health.lag_s.toFixed(1)}s` : "--"}</span>
      <span className="text-ink-dim">asr {health ? `${Math.round(health.gpu_ms_asr)}ms` : "--"}</span>
      <span className="text-ink-dim">diar {health && health.gpu_ms_diar > 0 ? `${Math.round(health.gpu_ms_diar)}ms` : "--"}</span>
      <span className="text-ink-dim">buffer {health ? `${health.buffer_s.toFixed(1)}s` : "--"}</span>
      <span className="text-ink-dim">extract {extract ? `${(extract.latency_ms / 1000).toFixed(1)}s` : "--"}</span>
      <span className="text-ink-dim">cost {formatCost(state.costUsd)}</span>
      {proxy && <span className={proxy === "ok" ? "text-live" : "text-bad"}>proxy {proxy}</span>}
      {session.status === "degraded" && last && <span className="text-bad">last event {wallTime(session.started_at, last.t1) ?? formatT(last.t1)}</span>}
      <span className={connection === "open" ? "text-live" : "text-warn"}>sse {connection}</span>
      <span className="text-ink-faint">{session.models.asr ?? ""}</span>
      {diarModel && <span className="text-ink-faint">{diarModel}</span>}
      <Link href={`/claims?session=${session.id}`} className={`text-ink-dim hover:text-accent ${session.status === "stopped" ? "ml-auto" : ""}`}>
        claims
      </Link>
      {session.status !== "stopped" && (
        <form action={stopSessionAction} className="ml-auto">
          <input type="hidden" name="id" value={session.id} />
          <button type="submit" className="rounded border border-line px-3 py-1 text-ink-dim hover:text-bad">
            Stop
          </button>
        </form>
      )}
    </footer>
  );
}
