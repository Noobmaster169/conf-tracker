"use client";

import type { ReactNode } from "react";

import type { CallDetail, Speaker } from "@/lib/api/schemas";
import { markQuote } from "@/lib/quote-mark";
import { speakerLabeller } from "@/lib/speaker-names";

import { ClaimLine, STATUS_ROW } from "./claims-feed";

/** One call in full: its numbers, what it produced, what it was sent and what it answered. */
export function CallBody({ detail, claimId, speakers }: { detail: CallDetail; claimId: number | null; speakers: Speaker[] }) {
  const { call, claims, proposals } = detail;
  const label = speakerLabeller(speakers);
  const selected = claims.find((c) => c.id === claimId) ?? null;
  const marked = selected ? markQuote(call.input, selected.quote) : null;
  const tokens = `${call.input_tokens ?? "--"}/${call.output_tokens ?? "--"}`;
  const cost = call.cost_usd === null ? "--" : `$${call.cost_usd.toFixed(4)}`;
  const parsed = call.parsed === null || call.parsed === undefined ? "(did not parse)" : JSON.stringify(call.parsed, null, 2);

  return (
    <div className="space-y-4 px-4 py-3">
      <p className="flex flex-wrap gap-x-4 text-ink-dim tabular-nums">
        <span>tokens {tokens}</span>
        <span>cost {cost}</span>
        <span>latency {(call.latency_ms / 1000).toFixed(1)}s</span>
        <span>created {new Date(call.created_at).toLocaleTimeString()}</span>
      </p>
      {call.error && <p className="break-words text-bad">{call.error}</p>}
      {call.step === "name" ? (
        <Section title="name proposals from this call">
          {proposals.length === 0 ? (
            <p className="text-ink-faint">(none)</p>
          ) : (
            <ul className="space-y-1">
              {proposals.map((p) => (
                <li key={p.id} className={p.status === "accepted" ? "text-ink" : "text-ink-dim"}>
                  <span className="tabular-nums">{p.confidence.toFixed(2)}</span> {p.speaker_id} {p.name}
                  {p.role ? `, ${p.role}` : ""} <span className={p.status === "accepted" ? "text-live" : "text-warn"}>{p.status}</span>
                  {p.reason && <span className="text-ink-faint"> ({p.reason})</span>}
                  <span className="block pl-4 text-xs text-ink-faint">&quot;{p.quote}&quot;</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : (
        <Section title="claims from this call">
          {claims.length === 0 ? (
            <p className="text-ink-faint">(none)</p>
          ) : (
            <ul>
              {claims.map((claim) => (
                <li key={claim.id} className={`px-1 py-0.5 ${STATUS_ROW[claim.status]} ${claim.id === claimId ? "bg-panel-raised" : ""}`}>
                  <ClaimLine claim={claim} speaker={label(claim.speaker_id)} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      <Section title="input">
        {selected && !marked && <p className="mb-1 break-words text-warn">quote not found in the window: &quot;{selected.quote}&quot;</p>}
        <pre className="whitespace-pre-wrap break-words text-xs">
          {marked ? (
            <>
              {marked.before}
              <mark className="bg-accent/30 text-ink">{marked.hit}</mark>
              {marked.after}
            </>
          ) : (
            call.input
          )}
        </pre>
      </Section>
      <Section title="output">
        <pre className="whitespace-pre-wrap break-words text-xs">{call.output ?? "(no answer)"}</pre>
      </Section>
      <Section title="parsed">
        <pre className="whitespace-pre-wrap break-words text-xs">{parsed}</pre>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs text-ink-faint">{title}</h3>
      {children}
    </section>
  );
}
