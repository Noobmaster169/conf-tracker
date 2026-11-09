"use client";

import Link from "next/link";
import { useActionState } from "react";

import { replaySessionAction, type ReplayState } from "@/app/actions/sessions";
import type { Session } from "@/lib/api/schemas";
import { configDiff, formatSetting } from "@/lib/compare";
import { REPLAY_SETTINGS, REPLAY_SPEEDS } from "@/lib/replay-settings";

export interface ReplayOrigin {
  id: string;
  title: string;
  config: Record<string, unknown>;
}

interface Props {
  session: Session; // the live state's session, so the Replay button appears when it stops
  original: ReplayOrigin | null;
}

/** One thin row above the panels: where a replay came from, or the way home, and the Replay panel once a session has ended. */
export function SessionBar({ session, original }: Props) {
  const changes = original ? configDiff(original.config, session.config) : [];
  return (
    <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 bg-panel px-4 py-1 text-sm">
      {original ? (
        <>
          <span className="min-w-0 truncate">
            Replay of{" "}
            <Link href={`/session/${original.id}`} className="text-ink hover:text-accent">
              {original.title}
            </Link>
          </span>
          <span className="min-w-0 break-words text-ink-dim">
            {changes.length === 0
              ? "same settings"
              : changes.map((c) => `${c.key} ${formatSetting(c.a)} → ${formatSetting(c.b)}`).join(" · ")}
          </span>
          <Link href={`/compare?a=${original.id}&b=${session.id}`} className="text-ink-dim hover:text-accent">
            Compare
          </Link>
        </>
      ) : (
        <Link href="/" className="text-ink-dim hover:text-accent">
          ← sessions
        </Link>
      )}
      {(session.status === "stopped" || session.status === "degraded") && <ReplayPanel session={session} />}
    </div>
  );
}

function ReplayPanel({ session }: { session: Session }) {
  const [state, action, pending] = useActionState<ReplayState, FormData>(replaySessionAction, { error: null });
  // Speed is how fast to replay, chosen by the radios; it is not a setting to carry over.
  const settings = Object.fromEntries(Object.entries(session.config).filter(([key]) => key !== "speed"));
  const prefilled = JSON.stringify(settings, null, 2);
  return (
    <details className="ml-auto">
      <summary className="cursor-pointer rounded border border-line px-3 py-0.5 text-ink-dim hover:text-accent">Replay</summary>
      {/* Above the sticky panel headers (z-10), below the audit drawer's overlay (z-20) and sheet (z-30). */}
      <form action={action} className="absolute right-4 top-full z-[15] mt-px flex w-[min(32rem,calc(100vw-2rem))] flex-col gap-2 border border-line bg-panel p-3">
        <input type="hidden" name="id" value={session.id} />
        <input type="hidden" name="original" value={prefilled} />
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">Speed</legend>
          <span className="text-ink-dim">speed</span>
          {REPLAY_SPEEDS.map((s) => (
            <label key={s.value} className="flex items-center gap-1">
              <input type="radio" name="speed" value={s.value} defaultChecked={s.value === 0} />
              {s.label}
            </label>
          ))}
        </fieldset>
        <textarea
          name="config"
          rows={8}
          defaultValue={prefilled}
          spellCheck={false}
          aria-label="Config overrides (JSON)"
          className="w-full rounded border border-line bg-bg p-2 font-mono text-xs text-ink"
        />
        {state.error && <p className="text-bad">{state.error}</p>}
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          {REPLAY_SETTINGS.map((g) => (
            <div key={g.group} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 font-mono">
              <span className="col-span-2 font-sans text-ink-dim">{g.group}</span>
              {g.items.map(([key, fallback]) => (
                <span key={key} className="contents">
                  <span className="truncate">{key}</span>
                  <span className="text-ink-dim">{fallback}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
        <button type="submit" disabled={pending} className="self-end rounded bg-accent px-4 py-1 text-bg disabled:opacity-60">
          {pending ? "Starting…" : "Start replay"}
        </button>
      </form>
    </details>
  );
}
