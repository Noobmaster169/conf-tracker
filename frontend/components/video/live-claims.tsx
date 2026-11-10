"use client";

import { ClaimCard } from "@/components/ui/claim-card";
import type { Claim } from "@/lib/api/schemas";
import type { FeedItem } from "@/lib/api/views";
import { formatT, plural } from "@/lib/format";
import { type SessionState, talkAt } from "@/lib/session-state";
import { speakerLabeller } from "@/lib/speaker-names";

/** A claim off the live stream, dressed as the feed serves it: its person and its session come from what the page already holds. */
function toItem(claim: Claim, state: SessionState, label: ReturnType<typeof speakerLabeller>): FeedItem {
  const who = label(claim.speaker_id);
  const speaker = state.speakers.find((s) => s.speaker_id === who.id);
  const talk = talkAt(state, claim.t0);
  return {
    ...claim,
    speaker_name: who.name,
    person: state.people.find((p) => p.id === speaker?.person_id) ?? null,
    talk: talk ? { id: talk.id, title: talk.title } : null,
    video: { session_id: state.session.id, video_id: state.session.video_id, title: state.session.title, started_at: state.session.started_at },
  };
}

/** What has been claimed in this video, newest first. Only claims whose quote was found in the transcript are shown. */
export function LiveClaims({ state, live, onSeek }: { state: SessionState; live: boolean; onSeek: (t: number) => void }) {
  const label = speakerLabeller(state.speakers);
  const claims = state.claims.filter((claim) => claim.status === "ok");
  const ordered = live ? [...claims].reverse() : claims;
  return (
    <section aria-label="Claims" className="flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface">
      <h2 className="flex items-baseline justify-between border-b border-line px-4 py-2.5 font-semibold">
        Claims
        {claims.length > 0 && <span className="text-[13px] font-normal text-ink-soft">{plural(claims.length, "claim")}</span>}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto bg-paper p-3">
        {ordered.length === 0 ? (
          <p className="py-6 text-center text-ink-soft">{live ? "No claims yet. They appear within a minute of being said." : "No claims were found in this video."}</p>
        ) : (
          <ol className="space-y-3">
            {ordered.map((claim) => (
              <li key={claim.id}>
                <ClaimCard
                  item={toItem(claim, state, label)}
                  hide={{ video: true }}
                  aside={
                    claim.t0 !== null && (
                      <button type="button" onClick={() => onSeek(claim.t0!)} className="text-accent hover:underline" title="Play from here">
                        {formatT(claim.t0)}
                      </button>
                    )
                  }
                />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
