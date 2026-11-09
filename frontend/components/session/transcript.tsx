"use client";

import { useEffect, useRef, useState } from "react";

import { delayed, nextRevealAt } from "@/lib/delay";
import { formatT, wallTime } from "@/lib/format";
import type { SessionState } from "@/lib/session-state";
import { speakerColor } from "@/lib/speaker-color";
import { speakerLabeller } from "@/lib/speaker-names";
import { toLines } from "@/lib/transcript-lines";

import { MAX_DELAY_S, useDelay } from "./use-delay";

/** Follows the newest line until the person scrolls up; a button brings them back. Live lines can be held back to match the video. */
export function Transcript({ state }: { state: SessionState }) {
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [delayS, setDelayS] = useDelay();
  // The clock the held lines are measured against; it only moves when a held line falls due. 0 holds every live line until the first wake.
  const [now, setNow] = useState(0);
  const { segments } = state;
  const shown = delayed(segments, state.arrivals, now, delayS);

  // State is set only from the timeout, never in the effect body; nothing held means nothing scheduled, so this cannot spin.
  useEffect(() => {
    const at = nextRevealAt(segments, state.arrivals, now, delayS);
    if (at === null) return;
    const handle = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()));
    return () => clearTimeout(handle);
  }, [segments, state.arrivals, delayS, now]);

  useEffect(() => {
    if (following && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, following]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const lines = toLines(shown, state.speakers, state.revisions);
  const label = speakerLabeller(state.speakers);
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1">
        <h2 className="text-ink-faint">transcript</h2>
        <label className="ml-auto flex items-center gap-2 text-xs text-ink-faint" title="Hold live lines back to line them up with the video">
          delay
          <input
            type="range"
            min={0}
            max={MAX_DELAY_S}
            step={1}
            value={delayS}
            onChange={(event) => setDelayS(Number(event.target.value))}
            aria-valuetext={`${delayS} seconds`}
            className="w-24 accent-accent"
          />
          <span className="w-7 text-right tabular-nums text-ink-dim">{delayS}s</span>
        </label>
      </div>
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {lines.length === 0 && <p className="text-ink-dim">Waiting for the first words...</p>}
        {lines.map((line) => {
          const who = label(line.speakerId);
          return (
            // The revision is in the key so a relabelled line remounts and its flash plays once; a snapshot resets it to 0.
            <div key={`${line.key}:${line.revision}`} className={`py-1 ${line.revision ? "relabel" : ""}`}>
              {/* A small header line (speaker, stream time, wall time) sits above the text so the text gets the full width. */}
              <div className="flex items-baseline gap-2 text-xs leading-4">
                <span className="min-w-0 truncate font-medium" style={{ color: speakerColor(who.id) }} title={who.name ? `${who.id} ${who.name}` : undefined}>
                  {who.name ?? who.id ?? "--"}
                </span>
                <span className="shrink-0 text-ink-faint tabular-nums">{formatT(line.t0)}</span>
                <span className="shrink-0 text-ink-faint tabular-nums">{wallTime(state.session.started_at, line.t0) ?? ""}</span>
              </div>
              <p className="break-words leading-6 text-ink">{line.text}</p>
            </div>
          );
        })}
      </div>
      {!following && (
        <button
          type="button"
          onClick={() => setFollowing(true)}
          className="absolute bottom-3 right-4 rounded bg-accent px-3 py-1 text-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Jump to live
        </button>
      )}
    </div>
  );
}
