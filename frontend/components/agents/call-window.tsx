import Link from "next/link";

import { clockText, dotClass, tookText } from "@/lib/agents";
import type { CallWindow as CallWindowData, FullCall } from "@/lib/api-client";

/** An answer that is JSON is laid out to be read; anything else is shown as it came. */
function readable(text: string | null): string {
  if (text === null) return "No answer came back.";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Pane({ title, children }: { title: string; children: string }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-soft">{title}</h3>
      <pre className="max-h-[56vh] min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-paper p-4 font-mono text-[12.5px] leading-relaxed">{children}</pre>
    </section>
  );
}

function Attempt({ call }: { call: FullCall }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Pane title="Input: what it was given">{call.input}</Pane>
      <Pane title="Output: what it answered">{readable(call.output)}</Pane>
    </div>
  );
}

/**
 * One call, opened over the agent's page: what it was given beside what it answered. It is part of the address
 * (`?call=`), so a call can be linked to, and closing it is a link back.
 */
export function CallWindow({ data, videoTitle, closeHref, now, children }: { data: CallWindowData; videoTitle: string | null; closeHref: string; now: Date; children?: React.ReactNode }) {
  const { call, attempts } = data;
  const earlier = attempts.filter((attempt) => attempt.id !== call.id);
  const caused = [
    ...data.claims.map((claim) => (claim.status === "ok" ? claim.claim : `${claim.claim} (${claim.status})`)),
    ...data.proposals.map((p) => `${p.speaker_id} is ${p.name}: ${p.status}${p.reason ? `, ${p.reason}` : ""}`),
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:items-center sm:p-6">
      <Link href={closeHref} scroll={false} aria-label="Close" className="fixed inset-0 cursor-default" />
      <div role="dialog" aria-modal="true" aria-label={data.result} className="relative flex max-h-full w-full min-w-0 max-w-[1040px] flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <header className="flex items-start gap-3 border-b border-line px-5 py-4 sm:px-6">
          <span className={`mt-2 size-2.5 shrink-0 rounded-full ${dotClass(data.status)}`} />
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-[17px] font-semibold leading-snug">{data.result}</h2>
            <p className="mt-0.5 text-[13px] text-ink-soft">
              {videoTitle ?? "Untitled video"} · {clockText(call.created_at, now)} · took {tookText(call.latency_ms)} · instructions {call.prompt_version} · {call.model}
            </p>
          </div>
          <Link href={closeHref} scroll={false} className="btn btn-quiet shrink-0">
            Close
          </Link>
        </header>
        <div className="min-w-0 overflow-y-auto px-5 py-5 sm:px-6">
          {call.error && (
            <p role="alert" className="mb-5 break-words rounded-lg bg-live-soft px-4 py-3 text-live">
              {call.error}
            </p>
          )}
          <Attempt call={call} />
          {caused.length > 0 && (
            <section className="mt-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-soft">What it caused</h3>
              <ul className="grid gap-1.5">
                {caused.map((line, i) => (
                  <li key={i} className="rounded-lg bg-sunk px-3 py-2 text-[14px]">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {earlier.map((attempt) => (
            <details key={attempt.id} className="mt-5">
              <summary className="cursor-pointer break-words text-[14px] font-medium text-ink-soft hover:text-ink">Attempt {attempt.attempt}, which was sent back: {attempt.error ?? "no error recorded"}</summary>
              <div className="mt-3">
                <Attempt call={attempt} />
              </div>
            </details>
          ))}
          {children}
        </div>
      </div>
    </div>
  );
}
