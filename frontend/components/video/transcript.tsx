"use client";

import { useEffect, useRef, useState } from "react";

import { formatT } from "@/lib/format";
import type { SessionState } from "@/lib/session-state";
import { speakerLabeller, voiceName } from "@/lib/speaker-names";
import { toLines } from "@/lib/transcript-lines";

/** The words as they are spoken, grouped by who is speaking. It follows the newest line until the reader scrolls up. */
export function Transcript({ state, live, onSeek }: { state: SessionState; live: boolean; onSeek: (t: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(live);
  const lines = toLines(state.segments, state.speakers, state.revisions);
  const label = speakerLabeller(state.speakers);

  useEffect(() => {
    if (following && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length, following]);

  const onScroll = () => {
    const el = box.current;
    if (el && live) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
  };

  return (
    <section aria-label="Transcript" className="relative flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-2.5 font-semibold">Transcript</h2>
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {lines.length === 0 && <p className="py-6 text-center text-ink-soft">{live ? "Waiting for the first words." : "No transcript was recorded."}</p>}
        {lines.map((line, i) => {
          const who = label(line.speakerId);
          const sameAsPrevious = i > 0 && label(lines[i - 1]!.speakerId).id === who.id;
          return (
            // Long recordings have thousands of lines; the browser skips laying out the ones off screen.
            <div key={line.key} className="py-1.5" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 3rem" }}>
              {!sameAsPrevious && (
                <p className="flex items-baseline gap-2 pt-1.5">
                  <span className={`font-semibold ${who.name ? "" : "text-ink-soft"}`}>{who.name ?? voiceName(who.id)}</span>
                  <button type="button" onClick={() => onSeek(line.t0)} className="text-[13px] text-ink-faint hover:text-accent hover:underline" title="Play from here">
                    {formatT(line.t0)}
                  </button>
                </p>
              )}
              <p className="max-w-[75ch] leading-relaxed">{line.text}</p>
            </div>
          );
        })}
      </div>
      {live && !following && (
        <button type="button" onClick={() => setFollowing(true)} className="btn absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg">
          Jump to latest
        </button>
      )}
    </section>
  );
}
