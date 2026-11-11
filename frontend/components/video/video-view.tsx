"use client";

import { useState } from "react";

import { LiveBadge } from "@/components/ui/bits";
import type { Snapshot } from "@/lib/api/schemas";
import { sessionState } from "@/lib/session-state";

import { LiveClaims } from "./live-claims";
import { OnStage } from "./on-stage";
import { Player } from "./player";
import { Transcript } from "./transcript";
import { useSessionStream } from "./use-session-stream";

/**
 * One video: the player, what is on stage, the transcript and the claims. On a wide screen the page is one fixed
 * frame with the video and transcript on the left and the claims on the right, each scrolling on its own; on a phone
 * they stack and the page scrolls.
 */
export function VideoView({ snapshot, start }: { snapshot: Snapshot; start: number | null }) {
  const state = useSessionStream(snapshot);
  const [seek, setSeek] = useState<number | null>(start);
  const { session, stage } = state;
  const live = session.status === "live" || session.status === "starting" || session.status === "recovering";
  const label = sessionState(session, state.health, state.gaps);
  const title = session.title ?? (stage ? `${stage.conference}, ${stage.name}` : "Untitled video");
  return (
    <main className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-5 sm:px-6 lg:h-[calc(100dvh-3.3rem)]">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="min-w-0 truncate text-xl font-bold tracking-tight">{title}</h1>
        {label.label === "Live" ? <LiveBadge /> : <span className={`text-[13px] font-medium ${label.label === "Ended" || label.label === "Starting" ? "text-ink-soft" : "text-live"}`}>{label.label}</span>}
        {label.detail && <span className="text-[13px] text-ink-soft">{label.detail}</span>}
        {stage && session.title && <span className="text-ink-soft">{`${stage.conference}, ${stage.name}`}</span>}
        {session.error && <span className="text-[13px] font-medium text-live">Stopped with an error: {session.error}</span>}
        {live && state.connection === "closed" && <span className="text-[13px] font-medium text-live">Connection lost. Reload the page to catch up.</span>}
      </header>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col gap-4">
          <Player videoId={session.video_id} start={seek} />
          <OnStage state={state} live={live} onSeek={setSeek} />
          <div className="flex h-[60vh] min-h-0 flex-col lg:h-auto lg:flex-1">
            <Transcript state={state} live={live} onSeek={setSeek} />
          </div>
        </div>
        <div className="flex h-[80vh] min-h-0 min-w-0 flex-col lg:h-auto">
          <LiveClaims state={state} live={live} onSeek={setSeek} />
        </div>
      </div>
    </main>
  );
}
