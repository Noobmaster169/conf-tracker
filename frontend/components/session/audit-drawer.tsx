"use client";

import { useEffect, useId, useState } from "react";

import { fetchCallDetail } from "@/lib/api/call-detail";
import type { CallDetail, Speaker } from "@/lib/api/schemas";
import { formatT } from "@/lib/format";

import { CallBody } from "./call-body";
import type { AuditTarget } from "./claims-feed";

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; detail: CallDetail };

type Props = { target: AuditTarget | null; speakers: Speaker[]; onClose: () => void };

/** One model call laid bare: what it was sent, what it answered, and the claims it produced. */
export function AuditDrawer({ target, speakers, onClose }: Props) {
  if (!target) return null;
  // Keyed on the call so a new call starts from a fresh loading state instead of showing the last one's texts.
  return <Drawer key={target.callId} target={target} speakers={speakers} onClose={onClose} />;
}

function Drawer({ target, speakers, onClose }: Props & { target: AuditTarget }) {
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const { callId } = target;

  useEffect(() => {
    const controller = new AbortController();
    fetchCallDetail(callId, controller.signal).then(
      (detail) => setLoad({ kind: "ready", detail }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [callId, attempt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-20 bg-bg/70" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="fixed inset-y-0 right-0 z-30 w-full max-w-2xl overflow-y-auto border-l border-line bg-panel"
      >
        <div className="sticky top-0 flex items-start gap-3 border-b border-line bg-panel px-4 py-2">
          <h2 id={headingId} className="min-w-0 flex-1 break-words text-ink">
            {load.kind === "ready" ? callHeading(load.detail) : `call #${callId}`}
          </h2>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="shrink-0 rounded border border-line px-2 text-ink-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Close
          </button>
        </div>
        {load.kind === "loading" && <p className="px-4 py-2 text-ink-faint">Loading call...</p>}
        {load.kind === "error" && (
          <p className="flex items-center gap-3 px-4 py-2 text-bad">
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
        )}
        {load.kind === "ready" && <CallBody detail={load.detail} claimId={target.claimId} speakers={speakers} />}
      </div>
    </>
  );
}

function callHeading({ call }: CallDetail): string {
  const head = `call #${call.id} · ${call.step} ${call.prompt_version} · ${call.model} · ${formatT(call.window_t0)}-${formatT(call.window_t1)}`;
  return call.attempt > 1 ? `${head} · attempt ${call.attempt}` : head;
}
