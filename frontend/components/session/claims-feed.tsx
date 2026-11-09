"use client";

import type { Claim } from "@/lib/api/schemas";
import { claimTime, lastCallLine, polarityGlyph, type Tone } from "@/lib/claims";
import type { SessionState } from "@/lib/session-state";
import { speakerColor } from "@/lib/speaker-color";
import { type SpeakerLabel, speakerLabeller } from "@/lib/speaker-names";
import { lastCallOf } from "@/lib/status";

export type AuditTarget = { callId: number; claimId: number | null };

const TONE_CLASS: Record<Tone, string> = { live: "text-live", bad: "text-bad", dim: "text-ink-dim", faint: "text-ink-faint" };

/** Unverified and duplicate claims stay listed for the audit, but fade so the verified ones lead. */
export const STATUS_ROW: Record<Claim["status"], string> = { ok: "", unverified: "opacity-60", duplicate: "opacity-50" };

const FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** Time, speaker, polarity and status: the marks the feed and the audit drawer both lead a claim with. */
function ClaimMarks({ claim, speaker }: { claim: Claim; speaker: SpeakerLabel }) {
  const { glyph, label, tone } = polarityGlyph(claim.polarity);
  return (
    <>
      <span className="w-14 shrink-0 text-ink-faint tabular-nums">{claimTime(claim)}</span>
      <span className="min-w-8 shrink-0" style={{ color: speakerColor(speaker.id) }} title={speaker.name ? (speaker.id ?? undefined) : undefined}>
        {speaker.name ?? speaker.id ?? "--"}
      </span>
      <span className={`shrink-0 ${TONE_CLASS[tone]}`} title={label} aria-label={label}>
        {glyph}
      </span>
      {claim.status === "unverified" && <span className="shrink-0 text-warn">unverified</span>}
      {claim.status === "duplicate" && <span className="shrink-0 text-ink-faint">dup</span>}
    </>
  );
}

/** The marks and the text on one line, for the audit drawer's wide list. */
export function ClaimLine({ claim, speaker }: { claim: Claim; speaker: SpeakerLabel }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <ClaimMarks claim={claim} speaker={speaker} />
      <span className="min-w-0 text-ink">{claim.claim}</span>
    </span>
  );
}

/** The marks and the topics as the feed row's header; topics wrap rather than push anything off the edge. */
function ClaimMeta({ claim, speaker }: { claim: Claim; speaker: SpeakerLabel }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <ClaimMarks claim={claim} speaker={speaker} />
      {claim.topics.map((topic) => (
        <span key={topic} className="rounded border border-line px-1 text-xs text-ink-dim">
          {topic}
        </span>
      ))}
    </span>
  );
}

/** Every claim extracted so far, newest first; a row opens the call that produced it. */
export function ClaimsFeed({ state, onOpen }: { state: SessionState; onOpen: (target: AuditTarget) => void }) {
  const label = speakerLabeller(state.speakers);
  const lastCall = lastCallOf(state.calls, "extract");
  const last = lastCallLine(lastCall);
  const claims = [...state.claims].reverse();

  return (
    <section aria-label="Claims">
      <div className="sticky top-0 z-10 border-b border-line bg-bg">
        <h2 className="px-3 py-1 text-ink-faint">{state.claims.length === 0 ? "claims" : `claims ${state.claims.length}`}</h2>
        {lastCall && last && (
          <button
            type="button"
            title={last.text}
            onClick={() => onOpen({ callId: lastCall.id, claimId: null })}
            className={`block w-full truncate px-3 pb-1 text-left text-xs hover:bg-panel-raised ${FOCUS} ${last.failed ? "text-bad" : "text-ink-faint"}`}
          >
            {last.text}
          </button>
        )}
      </div>
      {claims.length === 0 ? (
        <p className="px-3 py-2 text-ink-dim">No claims yet. The first extraction runs 30 s after the first words.</p>
      ) : (
        <ul className="divide-y divide-line">
          {claims.map((claim) => (
            <li key={claim.id} className={STATUS_ROW[claim.status]}>
              <button
                type="button"
                onClick={() => onOpen({ callId: claim.call_id, claimId: claim.id })}
                className={`flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-panel-raised ${FOCUS}`}
              >
                <ClaimMeta claim={claim} speaker={label(claim.speaker_id)} />
                {/* Claim and quote take the full column width and wrap; nothing in the feed is cut off. */}
                <span className="text-ink">{claim.claim}</span>
                <span className="border-l-2 border-line pl-2 text-xs leading-5 text-ink-dim">&quot;{claim.quote}&quot;</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
