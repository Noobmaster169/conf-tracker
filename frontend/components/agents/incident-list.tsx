import Link from "next/link";

import { resolveIncidentAction } from "@/app/actions/agents";
import { SubmitButton } from "@/components/admin/parts";
import { agoText, clockText } from "@/lib/agents";
import { type Incident, isOpen } from "@/lib/api-client";

function Entry({ incident, explains, now, back }: { incident: Incident; explains: Incident[]; now: Date; back: string }) {
  const open = isOpen(incident);
  const state = incident.resolved_at ? `went away ${agoText(incident.resolved_at, now)}` : incident.acknowledged_at ? "marked resolved, still there" : `since ${agoText(incident.first_seen, now)}`;
  return (
    <li id={`incident-${incident.id}`} className="border-b border-line last:border-b-0">
      <details className="group">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-1 py-3">
          <span className={`size-2 shrink-0 rounded-full ${open ? "bg-live" : "bg-line"}`} />
          <span className={`min-w-0 flex-1 break-words ${open ? "font-semibold" : "text-ink-soft"}`}>{incident.title}</span>
          {incident.count > 1 && <span className="shrink-0 text-[13px] tabular-nums text-ink-soft">×{incident.count}</span>}
          <span className="hidden shrink-0 text-[13px] text-ink-soft sm:block">{state}</span>
          <span aria-hidden className="text-ink-faint transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="grid gap-3 pb-4 pl-6 pr-1 text-[14px]">
          {incident.diagnosis && (
            <p className="rounded-lg bg-sunk px-3 py-2.5">
              <span className="mb-0.5 block text-xs font-semibold uppercase tracking-wider text-ink-soft">What the Watcher thinks</span>
              {incident.diagnosis}
            </p>
          )}
          {incident.detail && <p className="break-words text-ink-soft">{incident.detail}</p>}
          <p className="text-[13px] text-ink-soft">
            First seen {clockText(incident.first_seen, now)} UTC, last seen {clockText(incident.last_seen, now)} UTC
            {incident.session_title ? `, on ${incident.session_title}` : ""}.
          </p>
          {explains.length > 0 && (
            <ul className="grid gap-1">
              {explains.map((child) => (
                <li key={child.id} className="text-ink-soft">
                  Explains: {child.title}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {incident.agent_id && incident.call_id && (
              <Link href={`/admin/agents/${incident.agent_id}?call=${incident.call_id}`} className="btn btn-quiet">
                Open the call
              </Link>
            )}
            {open && (
              <form action={resolveIncidentAction}>
                <input type="hidden" name="id" value={incident.id} />
                <input type="hidden" name="back" value={back} />
                <SubmitButton quiet>Mark resolved</SubmitButton>
              </form>
            )}
          </div>
        </div>
      </details>
    </li>
  );
}

/** Everything the Watcher has recorded: what is wrong now, then what was. */
export function IncidentList({ incidents, now, back }: { incidents: Incident[]; now: Date; back: string }) {
  if (incidents.length === 0) return <p className="py-4 text-ink-soft">Nothing has gone wrong that it could see.</p>;
  const ids = new Set(incidents.map((i) => i.id));
  const tops = incidents.filter((i) => i.parent_id === null || !ids.has(i.parent_id) || !isOpen(i));
  const shown = new Set(tops.map((i) => i.id));
  return (
    <ul>
      {tops.map((incident) => (
        <Entry key={incident.id} incident={incident} explains={incidents.filter((i) => i.parent_id === incident.id && !shown.has(i.id))} now={now} back={back} />
      ))}
    </ul>
  );
}
