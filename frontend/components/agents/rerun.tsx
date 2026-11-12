"use client";

import { useEffect, useRef, useState } from "react";

import { startRerunAction } from "@/app/actions/agents";
import type { Rerun as RerunData } from "@/lib/api/agent-schemas";

const POLL_MS = 3000;

function readable(text: string | null): string {
  if (text === null) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * "Run again": sends the stored call once more with the chosen instructions and model and shows the new answer under
 * the stored one. It changes nothing that is stored; it is for judging a change before making it.
 */
export function Rerun({ callId, versions, models, version, model, stored }: { callId: number; versions: string[]; models: string[]; version: string; model: string; stored: string | null }) {
  const [chosenVersion, setVersion] = useState(version);
  const [chosenModel, setModel] = useState(model);
  const [rerun, setRerun] = useState<RerunData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (rerun?.status !== "pending") return;
    const id = rerun.id;
    const poll = async () => {
      try {
        const response = await fetch(`/api/reruns/${id}`, { cache: "no-store" });
        const body: unknown = await response.json();
        if (!response.ok) throw new Error((body as { error?: string }).error ?? "The rerun could not be read");
        setRerun(body as RerunData);
      } catch (cause) {
        // One missed poll is not the end of the rerun: say so and keep asking.
        setError(cause instanceof Error ? cause.message : "The rerun could not be read");
        timer.current = setTimeout(poll, POLL_MS);
      }
    };
    timer.current = setTimeout(poll, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [rerun]);

  async function start() {
    setStarting(true);
    setError(null);
    setRerun(null);
    const result = await startRerunAction(callId, chosenVersion, chosenModel);
    setStarting(false);
    if ("error" in result) setError(result.error);
    else setRerun(result.rerun);
  }

  const busy = starting || rerun?.status === "pending";
  return (
    <section className="mt-6 border-t border-line pt-5">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-soft">Run again</h3>
      <p className="mb-3 text-[13px] text-ink-soft">Sends the same input once more and shows what comes back. Nothing stored is changed.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink-soft">Instructions</span>
          <select value={chosenVersion} onChange={(event) => setVersion(event.target.value)} disabled={busy} className="field">
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink-soft">Model</span>
          <select value={chosenModel} onChange={(event) => setModel(event.target.value)} disabled={busy} className="field">
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={start} disabled={busy} className="btn">
          {busy ? "Running…" : "Run again"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 break-words rounded-lg bg-live-soft px-4 py-3 text-live">
          {error}
        </p>
      )}
      {rerun?.status === "failed" && (
        <p role="alert" className="mt-3 break-words rounded-lg bg-live-soft px-4 py-3 text-live">
          It failed: {rerun.error ?? "no reason given"}
        </p>
      )}
      {rerun?.status === "done" && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="min-w-0">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-soft">Stored answer</h4>
            <pre className="max-h-[48vh] min-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-paper p-4 font-mono text-[12.5px] leading-relaxed">{readable(stored) || "No answer was stored."}</pre>
          </div>
          <div className="min-w-0">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-soft">
              New answer, {rerun.prompt_version} on {rerun.model}
            </h4>
            <pre className="max-h-[48vh] min-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-paper p-4 font-mono text-[12.5px] leading-relaxed">{readable(rerun.output)}</pre>
            <p className={`mt-2 text-[13px] ${rerun.parsed_ok ? "text-ok" : "text-live"}`}>{rerun.parsed_ok ? "It matches the expected shape." : "It does not match the expected shape."}</p>
          </div>
          <p className="text-[13px] text-ink-soft md:col-span-2">{rerun.note}</p>
        </div>
      )}
    </section>
  );
}
