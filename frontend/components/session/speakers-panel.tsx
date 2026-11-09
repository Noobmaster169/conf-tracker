"use client";

import { useState } from "react";

import { formatT } from "@/lib/format";
import { activeSpeakers, type SessionState, speakersHeading } from "@/lib/session-state";
import { speakerColor } from "@/lib/speaker-color";
import { mergedFrom } from "@/lib/speaker-names";

import { SpeakerDetailView } from "./speaker-detail";

/** Everyone the registry knows, in the order they first spoke. One row opens at a time to show its name proposals and match scores. */
export function SpeakersPanel({ state, onOpenCall }: { state: SessionState; onOpenCall: (callId: number) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const active = activeSpeakers(state);

  return (
    <section aria-label="Speakers">
      <h2 className="sticky top-0 z-10 border-b border-line bg-bg px-3 py-1 text-ink-faint">{speakersHeading(state.speakers)}</h2>
      {state.speakers.length === 0 ? (
        <p className="px-3 py-2 text-ink-dim">No speakers yet. The first window closes 10 s in.</p>
      ) : (
        <ul className="divide-y divide-line">
          {state.speakers.map((speaker) => {
            const id = speaker.speaker_id;
            const expanded = open === id;
            const isActive = active.has(id);
            const merged = mergedFrom(state.speakers, id);
            return (
              <li key={id} className={speaker.merged_into ? "opacity-50" : undefined}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : id)}
                  className={`flex min-h-10 w-full items-start gap-3 px-3 text-left tabular-nums hover:bg-panel-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${expanded ? "bg-panel-raised" : ""}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5">
                    <span className="flex min-w-0 items-center gap-3">
                      <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: speakerColor(id) }} />
                      <span className="w-8 shrink-0" style={{ color: speakerColor(id) }}>
                        {id}
                      </span>
                      <span className={isActive ? "text-live" : "text-ink-faint"} title={isActive ? "speaking in the last 10 s" : "quiet"}>
                        ●<span className="sr-only">{isActive ? " active" : " quiet"}</span>
                      </span>
                      <span className={`min-w-0 truncate ${speaker.name ? "text-ink" : "text-ink-faint"}`}>{speaker.name ?? "unnamed"}</span>
                      <span className="ml-auto shrink-0 text-ink">{speaker.merged_into ? `into ${speaker.merged_into}` : formatT(speaker.talk_s)}</span>
                    </span>
                    <span className="flex min-w-0 gap-2 pl-[3.25rem] text-xs text-ink-faint">
                      {speaker.role && <span className="min-w-0 truncate text-ink-dim">{speaker.role}</span>}
                      {speaker.name_confidence !== null && <span className="tabular-nums">{speaker.name_confidence.toFixed(2)}</span>}
                      {merged.length > 0 && <span>+{merged.join(" +")}</span>}
                      <span className="ml-auto">since {formatT(speaker.first_seen_t)}</span>
                    </span>
                  </span>
                  <span aria-hidden className="w-3 py-1.5 text-ink-faint">
                    {expanded ? "-" : "+"}
                  </span>
                </button>
                {expanded && (
                  <div className="bg-panel pb-1">
                    <SpeakerDetailView sessionId={state.session.id} speakerId={id} onOpenCall={onOpenCall} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
