import Link from "next/link";

import { agoText } from "@/lib/agents";
import type { Incident } from "@/lib/api-client";

/** Where an incident is best read: the call that shows it, or its entry on the Watcher's page. */
export function incidentHref(incident: Incident): string {
  if (incident.agent_id && incident.call_id) return `/admin/agents/${incident.agent_id}?call=${incident.call_id}`;
  return `/admin/agents/watch#incident-${incident.id}`;
}

/** Something is wrong, said once, at the top. Shown only while it is. */
export function IncidentBanner({ incident, related = 0, now }: { incident: Incident; related?: number; now: Date }) {
  return (
    <Link href={incidentHref(incident)} className="mb-3 flex items-start gap-3 rounded-xl border border-live/40 bg-live-soft px-4 py-3.5 transition-colors hover:border-live">
      <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-live" />
      <span className="min-w-0 flex-1">
        <span className="block break-words font-semibold">
          {incident.title}
          {related > 0 && <span className="font-normal text-ink-soft"> and {related} related</span>}
        </span>
        {incident.diagnosis && <span className="mt-0.5 block break-words text-[14px] text-ink-soft">{incident.diagnosis}</span>}
        <span className="mt-0.5 block text-[13px] text-ink-soft">since {agoText(incident.first_seen, now)}</span>
      </span>
      <span className="hidden shrink-0 text-[13px] text-ink-soft sm:block">See what happened →</span>
    </Link>
  );
}

/** The banners for a list of open incidents: one per cause, with what it explains counted under it. */
export function IncidentBanners({ incidents, now }: { incidents: Incident[]; now: Date }) {
  const ids = new Set(incidents.map((i) => i.id));
  const tops = incidents.filter((i) => i.parent_id === null || !ids.has(i.parent_id));
  if (tops.length === 0) return null;
  return (
    <div className="mb-6">
      {tops.map((incident) => (
        <IncidentBanner key={incident.id} incident={incident} related={incidents.filter((i) => i.parent_id === incident.id).length} now={now} />
      ))}
    </div>
  );
}
