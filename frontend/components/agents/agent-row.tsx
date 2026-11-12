import Link from "next/link";

import { clockText, dotClass, lastRunText, toneClass } from "@/lib/agents";
import type { AgentCard, RunSummary } from "@/lib/api-client";

import { RunStrip } from "./run-strip";

/**
 * One agent on the overview, across the whole width: who it is, the last thing it did, how its last runs went, and
 * what it is working with. Nothing is cut short; the whole row opens its page.
 */
export function AgentRow({ agent, latest, now }: { agent: AgentCard; latest: RunSummary | null; now: Date }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        href={`/admin/agents/${agent.id}`}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-sunk lg:grid-cols-[auto_minmax(0,22rem)_minmax(0,1fr)_auto_7rem_8rem_auto]"
      >
        <span className={`size-2.5 rounded-full ${dotClass(agent.status)}`} />
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold">{agent.name}</span>
          <span className="block text-[14px] text-ink-soft">{agent.role}</span>
        </span>
        <span className="col-span-2 col-start-2 min-w-0 lg:col-span-1 lg:col-start-auto">
          {latest ? (
            <>
              <span className={`block text-[14px] ${latest.status === "ok" ? "" : toneClass(latest.status)}`}>{latest.result}</span>
              <span className="block text-[13px] text-ink-soft">
                {latest.session_title ?? "Untitled video"} · {clockText(latest.created_at, now)}
              </span>
            </>
          ) : (
            <span className="text-[14px] text-ink-soft">{agent.internal ? "Nothing to look into yet." : "It has not run yet."}</span>
          )}
        </span>
        <span className="hidden lg:block">
          <RunStrip recent={agent.recent} />
        </span>
        <span className="hidden text-[13px] text-ink-soft lg:block">
          {agent.prompt_version ?? "-"} · {agent.model ?? "-"}
        </span>
        <span className="hidden text-right text-[13px] text-ink-soft lg:block">{lastRunText(agent, now)}</span>
        <span aria-hidden className="row-start-1 col-start-3 text-ink-faint lg:row-start-auto lg:col-start-auto">›</span>
      </Link>
    </li>
  );
}
