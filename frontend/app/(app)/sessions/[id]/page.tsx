import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { LiveBadge, Page } from "@/components/ui/bits";
import { ClaimCard } from "@/components/ui/claim-card";
import { Summary } from "@/components/ui/summary";
import { getTalk } from "@/lib/api-client";
import { formatDay, formatT, plannedTime, plural, titleAndOrg } from "@/lib/format";

export const dynamic = "force-dynamic";

const WAITING = {
  upcoming: "This session has not been on stage yet. Its summary and claims appear here once it has.",
  live: "On stage now. Claims appear below as they are made, and the summary is written when the session ends.",
  ended: "No summary has been written for this session.",
} as const;

export default async function SessionPage({ params }: PageProps<"/sessions/[id]">) {
  const { id } = await params;
  const detail = await getTalk(id);
  if (!detail) notFound();
  const { talk, stage, summary, claims } = detail;
  const when = [formatDay(stage.day), plannedTime(talk.starts_at, talk.ends_at)].filter(Boolean).join(", ");
  return (
    <Page narrow>
      <p className="mb-2 text-ink-soft">
        <Link href="/sessions" className="hover:text-accent hover:underline">
          Sessions
        </Link>
        <span className="mx-2 text-ink-faint">/</span>
        {stage.conference}, {stage.name}
      </p>
      <h1 className="text-[32px] font-bold leading-tight tracking-tight">{talk.title}</h1>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-soft">
        {detail.status === "live" && <LiveBadge label="On stage" />}
        {when && <span>{when}</span>}
        <span className="capitalize">{talk.kind}</span>
        {detail.session_id && (
          <Link href={`/video/${detail.session_id}${detail.t0 === null ? "" : `?t=${Math.floor(detail.t0)}`}`} className="font-medium text-accent hover:underline">
            {detail.t0 === null ? "Watch the video" : `Watch from ${formatT(detail.t0)}`}
          </Link>
        )}
      </p>
      {talk.speakers.length > 0 && (
        <ul className="mt-6 flex flex-wrap gap-x-8 gap-y-4">
          {talk.speakers.map((speaker) => (
            <li key={speaker.id}>
              <Link href={`/speakers/${speaker.id}`} className="flex items-center gap-3 hover:text-accent">
                <Avatar name={speaker.name} photoUrl={speaker.photo_url} />
                <span>
                  <span className="block font-semibold leading-tight">{speaker.name}</span>
                  <span className="block text-[13px] leading-tight text-ink-soft">{[speaker.role === "speaker" ? null : speaker.role, titleAndOrg(speaker)].filter(Boolean).join(", ")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {talk.description && <p className="mt-6 max-w-[72ch] text-ink-soft">{talk.description}</p>}

      <section aria-label="Summary" className="mt-8 rounded-2xl border border-line bg-surface p-6 sm:p-8">
        {summary ? <Summary summary={summary.summary} /> : <p className="text-ink-soft">{WAITING[detail.status]}</p>}
      </section>

      {claims.length > 0 && (
        <section aria-labelledby="claims" className="mt-10">
          <h2 id="claims" className="mb-4 text-lg font-semibold">
            {plural(claims.length, "claim")} from this session
          </h2>
          <ol className="space-y-3">
            {claims.map((item) => (
              <li key={item.id}>
                <ClaimCard item={item} hide={{ talk: true }} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </Page>
  );
}
