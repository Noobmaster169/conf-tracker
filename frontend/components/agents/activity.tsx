import Link from "next/link";

import { clockText, dotClass } from "@/lib/agents";
import type { ActivityLine } from "@/lib/api-client";

/** What it did and what was done to it, in one line of time. A change stands out from the runs around it. */
export function Activity({ lines, hrefFor, now }: { lines: ActivityLine[]; hrefFor: (callId: number) => string; now: Date }) {
  if (lines.length === 0) return <p className="py-4 text-ink-soft">Nothing yet.</p>;
  return (
    <ul>
      {lines.map((line, i) => {
        const isCall = line.kind === "call";
        const body = (
          <>
            {isCall ? <span className={`size-2 shrink-0 rounded-full ${dotClass(line.status ?? "ok")}`} /> : <span className="w-2 shrink-0 text-center text-[13px] leading-none text-accent">✎</span>}
            <span className="w-24 shrink-0 text-[13px] tabular-nums text-ink-soft">{clockText(line.at, now)}</span>
            <span className={`min-w-0 flex-1 break-words ${isCall ? "text-ink-soft" : "font-medium"}`}>{line.summary}</span>
            {line.actor && <span className="shrink-0 rounded-full bg-sunk px-2 py-0.5 text-[12px] text-ink-soft">{line.actor}</span>}
          </>
        );
        return (
          <li key={`${line.at}-${i}`}>
            {line.call_id ? (
              <Link href={hrefFor(line.call_id)} scroll={false} className="flex min-h-10 items-center gap-3 rounded-lg px-3 py-1.5 transition-colors hover:bg-sunk">
                {body}
              </Link>
            ) : (
              <div className="flex min-h-10 items-center gap-3 px-3 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
