import Link from "next/link";

import { agoText, dotClass } from "@/lib/agents";
import type { AgentCard } from "@/lib/api-client";

import { RunStrip } from "./run-strip";

/** One agent on the overview: how it is doing, at a glance. The whole row opens its page. */
export function AgentRow({ agent, now }: { agent: AgentCard; now: Date }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <Link href={`/admin/agents/${agent.id}`} className="flex min-h-16 items-center gap-4 px-5 py-4 transition-colors hover:bg-sunk">
        <span className={`size-2.5 shrink-0 rounded-full ${dotClass(agent.status)}`} />
        <span className="w-28 shrink-0 text-[16px] font-semibold">{agent.name}</span>
        <span className="hidden min-w-0 flex-1 truncate text-ink-soft sm:block">{agent.role}</span>
        <span className="ml-auto hidden md:block">
          <RunStrip recent={agent.recent} />
        </span>
        <span className="w-28 shrink-0 text-right text-[13px] text-ink-soft">{agoText(agent.last_run_at, now)}</span>
        <span aria-hidden className="text-ink-faint">›</span>
      </Link>
    </li>
  );
}
