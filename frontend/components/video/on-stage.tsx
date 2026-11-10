"use client";

import Link from "next/link";

import { Avatar } from "@/components/ui/avatar";
import { LiveBadge } from "@/components/ui/bits";
import { formatT } from "@/lib/format";
import { nowOnStage, type SessionState } from "@/lib/session-state";

/** Which session is running, and the sessions this video has been through so far; each one jumps the player to its start. */
export function OnStage({ state, live, onSeek }: { state: SessionState; live: boolean; onSeek: (t: number) => void }) {
  if (!state.stage) return null;
  const now = live ? nowOnStage(state) : null;
  const heard = state.spans.filter((span) => span.state === "talk" && span.talk_id !== null);
  return (
    <section aria-label="Sessions in this video" className="rounded-xl border border-line bg-surface">
      {live && (
        <div className="flex items-start gap-4 p-4">
          <div className="min-w-0 flex-1">
            <p className="mb-1 flex items-center gap-2 text-[13px] font-medium text-ink-soft">
              {now?.talk ? <LiveBadge label="On stage now" /> : now ? "Between sessions" : "Listening for the first session"}
            </p>
            {now?.talk && (
              <>
                <Link href={`/sessions/${now.talk.id}`} className="text-lg font-semibold leading-snug hover:text-accent">
                  {now.talk.title}
                </Link>
                <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                  {now.talk.speakers.map((speaker) => (
                    <li key={speaker.id} className="flex items-center gap-2 text-[13px]">
                      <Avatar name={speaker.name} photoUrl={speaker.photo_url} size="sm" />
                      <span className="font-medium">{speaker.name}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
      {heard.length > 0 && (
        <details className={live ? "border-t border-line" : ""} open={!live}>
          <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-ink-soft hover:text-ink">Sessions in this video ({heard.length})</summary>
          <ol className="max-h-56 overflow-y-auto border-t border-line">
            {heard.map((span) => {
              const talk = state.talks.find((t) => t.id === span.talk_id);
              return (
                <li key={span.id} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                  <button type="button" onClick={() => onSeek(span.t0)} className="w-14 shrink-0 text-left text-accent hover:underline" title="Play from here">
                    {formatT(span.t0)}
                  </button>
                  {talk ? (
                    <Link href={`/sessions/${talk.id}`} className="min-w-0 truncate hover:text-accent hover:underline">
                      {talk.title}
                    </Link>
                  ) : (
                    <span className="text-ink-soft">A session no longer on the schedule</span>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </section>
  );
}
