import Link from "next/link";

import { LiveBadge } from "@/components/ui/bits";
import { thumbnailUrl, watchUrl } from "@/lib/format";
import type { StageGroup } from "@/lib/monitor";

/** One line under the stage's name: what is on now, or what it last had on. */
function Headline({ group }: { group: StageGroup }) {
  const { lead, live } = group;
  const talk = live ? lead.now : lead.last_talk;
  const lead_in = live ? (lead.session.status === "starting" ? "Starting" : talk ? null : "Between sessions") : talk ? "Last:" : "Ended";
  return (
    <p className="mt-1 line-clamp-2 text-[15px] leading-snug">
      {lead_in && <span className="text-ink-soft">{lead_in} </span>}
      {talk && (
        <Link href={`/sessions/${talk.id}`} className={`hover:text-accent hover:underline ${live ? "font-semibold" : "text-ink-soft"}`}>
          {talk.title}
        </Link>
      )}
    </p>
  );
}

/**
 * A stage at a glance: its name, whether it is live, what is on, and the newest picture of it. The picture opens the
 * stream on YouTube. Without a picture yet (or from an older api), YouTube's own still stands in.
 */
export function StageCard({ group, compact = false }: { group: StageGroup; compact?: boolean }) {
  const { lead, live } = group;
  const videoId = lead.session.video_id;
  const picture = lead.frame?.url ?? (videoId ? thumbnailUrl(videoId) : null);
  return (
    <article className="min-w-0">
      <header className="flex items-center gap-2">
        <h2 className="min-w-0 truncate text-[13px] font-semibold uppercase tracking-wide text-ink-soft">{group.name}</h2>
        {live ? <LiveBadge /> : <span className="rounded-full bg-sunk px-2 py-0.5 text-xs font-semibold text-ink-soft">Ended</span>}
      </header>
      {!compact && <Headline group={group} />}
      {picture && (
        <a
          href={videoId ? watchUrl(videoId) : undefined}
          target="_blank"
          rel="noreferrer"
          title={videoId ? "Watch on YouTube" : undefined}
          className="mt-3 block overflow-hidden rounded-xl border border-line bg-sunk"
        >
          {/* The image changes key with every new picture, so the browser never shows a stale one under a new card. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={picture} src={picture} alt={`${group.name}, ${live ? "now" : "last picture"}`} className="aspect-video w-full object-cover" />
        </a>
      )}
      {compact && <Headline group={group} />}
    </article>
  );
}
