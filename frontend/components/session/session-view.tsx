"use client";

import { useState } from "react";

import type { Snapshot } from "@/lib/api/schemas";

import { AuditDrawer } from "./audit-drawer";
import { ClaimsFeed } from "./claims-feed";
import { SessionBar, type ReplayOrigin } from "./session-bar";
import { SpeakersPanel } from "./speakers-panel";
import { StatusBar } from "./status-bar";
import { TopicsPanel } from "./topics-panel";
import { Transcript } from "./transcript";
import { useSessionStream } from "./use-session-stream";
import { VideoEmbed } from "./video-embed";

export function SessionView({ snapshot, original, error }: { snapshot: Snapshot; original: ReplayOrigin | null; error?: string }) {
  const state = useSessionStream(snapshot);
  const [target, setTarget] = useState<{ callId: number; claimId: number | null } | null>(null);
  return (
    <main className="grid min-h-screen grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_auto_auto_auto] gap-px bg-line lg:h-screen lg:grid-rows-[auto_minmax(0,1fr)_auto]">
      <SessionBar session={state.session} original={original} />
      {/* Three full-height columns on wide screens, so the transcript and the claims read as tall lists instead of a wide strip. Narrower, they stack and the page scrolls. */}
      <div className="contents lg:grid lg:min-h-0 lg:grid-cols-[minmax(20rem,3fr)_minmax(0,4fr)_minmax(20rem,3.5fr)] lg:gap-px">
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-px">
          <section className="bg-bg p-3">
            <VideoEmbed videoId={state.session.video_id} />
          </section>
          <div className="max-h-[30vh] min-h-0 overflow-y-auto bg-bg lg:max-h-none">
            <SpeakersPanel state={state} onOpenCall={(callId) => setTarget({ callId, claimId: null })} />
          </div>
          <div className="max-h-[16rem] min-h-0 overflow-y-auto bg-bg">
            <TopicsPanel state={state} />
          </div>
        </div>
        <section className="h-[70vh] min-h-0 bg-bg lg:h-auto">
          <Transcript state={state} />
        </section>
        <div className="h-[70vh] min-h-0 overflow-y-auto bg-bg lg:h-auto">
          <ClaimsFeed state={state} onOpen={setTarget} />
        </div>
      </div>
      <div>
        {error && <p className="truncate bg-panel px-4 py-1 text-bad">{error}</p>}
        <StatusBar state={state} />
      </div>
      <AuditDrawer target={target} speakers={state.speakers} onClose={() => setTarget(null)} />
    </main>
  );
}
