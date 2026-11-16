import Link from "next/link";

import { Avatar } from "@/components/ui/avatar";
import { LiveBadge } from "@/components/ui/bits";
import { TimeAgo } from "@/components/ui/time-ago";
import { speakerLine, thumbnailUrl, watchUrl } from "@/lib/format";
import type { Lineup, LineupTalk, StageGroup } from "@/lib/monitor";

const label = "text-xs font-semibold uppercase tracking-wide";

function Speakers({ talk, size }: { talk: LineupTalk; size: "sm" | "md" }) {
  if (talk.speakers.length === 0) return null;
  if (size === "sm") return <p className="mt-1 truncate text-[13px] text-ink-soft">{talk.speakers.map((s) => s.name).join(", ")}</p>;
  return (
    <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-3">
      {talk.speakers.map((s) => (
        <li key={s.id} className="flex min-w-0 items-center gap-2.5">
          <Avatar name={s.name} photoUrl={s.photo_url} size="md" />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-medium">{s.name}</span>
            {speakerLine(s) && <span className="block truncate text-[13px] text-ink-soft">{speakerLine(s)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The session the card leads with: on now, or the last one an ended stage had. */
const button = "inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[14px] font-semibold transition-colors";
const outline = `${button} border border-line hover:border-accent hover:text-accent`;

/** Where the Monitor leads on: the lead session's own page and, on the first card, the whole schedule and every speaker. */
export interface StageLinks {
  sessions: string;
}

function Lead({ group, lineup, links }: { group: StageGroup; lineup: Lineup; links?: StageLinks }) {
  const { now } = lineup;
  const starting = group.live && group.lead.session.status === "starting";
  const lead_in = group.live ? (starting ? "Starting" : now ? "On now" : "Between sessions") : "Last on stage";
  return (
    <div className="min-w-0">
      <p className={`flex items-center gap-2 ${label} ${group.live && now ? "text-live" : "text-ink-soft"}`}>
        {lead_in}
        {now?.time && <span className="font-medium normal-case tracking-normal text-ink-soft">· {now.time}</span>}
      </p>
      {now ? (
        <>
          <h3 className="mt-2 text-[24px] font-bold leading-tight tracking-tight text-balance @3xl:text-[32px]">
            <Link href={`/sessions/${now.id}`} className="hover:text-accent">
              {now.title}
            </Link>
          </h3>
          <Speakers talk={now} size="md" />
        </>
      ) : (
        <p className="mt-2 text-[24px] font-bold leading-tight tracking-tight text-ink-soft @3xl:text-[32px]">{group.live ? "Nothing on stage right now" : "No session recorded"}</p>
      )}
      {(now || links) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {now && (
            <Link href={`/sessions/${now.id}`} className={`${button} bg-accent-fill text-on-accent hover:opacity-90`}>
              View Session Details <span aria-hidden>→</span>
            </Link>
          )}
          {links && (
            <>
              <Link href={links.sessions} className={outline}>
                View all Sessions
              </Link>
              <Link href="/speakers" className={outline}>
                View all Speakers
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The stage's newest picture, wide, with how long ago it was taken and a link to the stream on YouTube under it. */
function Snapshot({ group }: { group: StageGroup }) {
  const { lead, live } = group;
  const videoId = lead.session.video_id;
  const picture = lead.frame?.url ?? (videoId ? thumbnailUrl(videoId) : null);
  if (!picture && !videoId) return null;
  const href = videoId ? watchUrl(videoId) : undefined;
  return (
    <div className="min-w-0 self-start">
      {picture && (
        <a href={href} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-line bg-sunk">
          {/* The image changes key with every new picture, so the browser never shows a stale one under a new card. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={picture} src={picture} alt={`${group.name}, ${live ? "now" : "last picture"}`} className="aspect-video w-full object-cover transition-opacity hover:opacity-90" />
        </a>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-3 text-[13px]">
        <span className="text-ink-soft">{lead.frame && <TimeAgo iso={lead.frame.created_at} />}</span>
        {href && (
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-semibold transition-colors hover:border-accent hover:text-accent">
            {live && <span aria-hidden className="live-dot size-1.5 rounded-full bg-live" />}
            {live ? "Watch Live Video" : "Watch Video"}
            <span aria-hidden>↗</span>
          </a>
        )}
      </div>
    </div>
  );
}

function Neighbour({ heading, talk, empty }: { heading: string; talk: LineupTalk | null; empty: string }) {
  const body = (
    <>
      <p className={`${label} text-ink-soft`}>
        {heading}
        {talk?.time && <span className="font-medium normal-case tracking-normal"> · {talk.time}</span>}
      </p>
      {talk ? (
        <>
          <p className="mt-1.5 line-clamp-2 font-semibold leading-snug group-hover:text-accent">{talk.title}</p>
          <Speakers talk={talk} size="sm" />
        </>
      ) : (
        <p className="mt-1.5 text-ink-faint">{empty}</p>
      )}
    </>
  );
  return talk ? (
    <Link href={`/sessions/${talk.id}`} className="group block min-w-0 px-5 py-4 transition-colors hover:bg-sunk">
      {body}
    </Link>
  ) : (
    <div className="min-w-0 px-5 py-4">{body}</div>
  );
}

/**
 * A stage at a glance, read top to bottom: whether it is live, the session on it now (or the last one it had), and the
 * sessions either side of that. The newest picture sits beside it as a supporting view and opens the stream on YouTube.
 */
export function StageCard({ group, lineup, links }: { group: StageGroup; lineup: Lineup; links?: StageLinks }) {
  const { live } = group;
  const showNext = live || lineup.next !== null;
  return (
    <article className="@container flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
      <header className="flex items-center gap-2 px-5 pt-5">
        <h2 className="min-w-0 truncate text-sm font-semibold">{group.name}</h2>
        {live ? <LiveBadge /> : <span className="rounded-full bg-sunk px-2 py-0.5 text-xs font-semibold text-ink-soft">Ended</span>}
      </header>
      <div className="grid gap-5 px-5 pt-4 pb-5 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] @3xl:gap-8">
        <Lead group={group} lineup={lineup} links={links} />
        <Snapshot group={group} />
      </div>
      <div className={`mt-auto grid border-t border-line ${showNext ? "divide-y divide-line @xl:grid-cols-2 @xl:divide-x @xl:divide-y-0" : ""}`}>
        <Neighbour heading="Before" talk={lineup.before} empty="The first session of the day" />
        {showNext && <Neighbour heading={live ? "Up next" : "After"} talk={lineup.next} empty="Nothing more scheduled" />}
      </div>
    </article>
  );
}
