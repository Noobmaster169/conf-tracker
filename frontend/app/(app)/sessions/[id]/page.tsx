import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { BackButton } from "@/components/ui/back-button";
import { Empty, Page, StatusTag, Tabs } from "@/components/ui/bits";
import { ClaimCard } from "@/components/ui/claim-card";
import { FrameStrip, Gallery } from "@/components/ui/gallery";
import { PostCard } from "@/components/ui/post-card";
import { Summary } from "@/components/ui/summary";
import { getTalk, getTalkFrames, getTalkTranscript } from "@/lib/api-client";
import { formatDay, formatT, plannedTime, plural, readableDescription, titleAndOrg, watchUrl } from "@/lib/format";
import { transcriptTurns } from "@/lib/transcript";

export const dynamic = "force-dynamic";

const NO_SUMMARY = {
  upcoming: "This session has not been on stage yet. Its summary is written once it has ended.",
  live: "On stage now. The summary is written when the session ends.",
  ended: "No summary has been written for this session.",
} as const;

const NO_POST = {
  upcoming: "This session has not been on stage yet. Its post for X is written once it has ended.",
  live: "On stage now. The post for X is written when the session ends.",
  ended: "No post has been written for this session yet. It follows the summary.",
} as const;

const NO_CLAIMS = {
  upcoming: "This session has not been on stage yet. Claims appear here as they are made.",
  live: "On stage now. Claims appear here as they are made.",
  ended: "No claims were tracked in this session.",
} as const;

/** The sections of a session, Claims first. A new one is a new entry here and a branch below. */
const NO_FRAMES = {
  upcoming: "This session has not been on stage yet. Pictures of the stage appear here while it runs.",
  live: "On stage now. Pictures of the stage appear here as the slides and speakers change.",
  ended: "No pictures were taken of this session.",
} as const;

const NO_TRANSCRIPT = {
  upcoming: "This session has not been on stage yet. Its transcript appears here as it is spoken.",
  live: "On stage now. The transcript appears here as it is spoken.",
  ended: "No transcript was recorded for this session.",
} as const;

const TABS = ["claims", "summary", "post", "transcript", "gallery"] as const;
type Tab = (typeof TABS)[number];
const parseTab = (value: unknown): Tab => (TABS.includes(value as Tab) ? (value as Tab) : "claims");

export default async function SessionPage({ params, searchParams }: PageProps<"/sessions/[id]">) {
  const { id } = await params;
  const tab = parseTab((await searchParams).tab);
  const [detail, frames] = await Promise.all([getTalk(id), getTalkFrames(id)]);
  if (!detail) notFound();
  const { talk, stage, summary, post, claims } = detail;
  const heard = tab === "transcript" && detail.session_id !== null && detail.t0 !== null ? await getTalkTranscript(detail.session_id, detail.t0, detail.t1) : null;
  const turns = heard ? transcriptTurns(heard.segments, heard.speakers, heard.people) : [];
  // The schedule this session is on: its day and stage.
  const sessionsHref = stage.day ? `/sessions?day=${encodeURIComponent(stage.day)}&stage=${encodeURIComponent(stage.id)}` : "/sessions";
  const when = [formatDay(stage.day), plannedTime(talk.starts_at, talk.ends_at)].filter(Boolean).join(", ");
  return (
    <Page narrow>
      <BackButton fallback={sessionsHref} />
      <p className="mb-2 text-[14px] font-medium text-ink-soft">
        {stage.conference} · {stage.name}
      </p>
      <h1 className="text-[28px] font-bold leading-tight tracking-tight sm:text-[32px]">{talk.title}</h1>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] text-ink-soft">
        <StatusTag status={detail.status} liveLabel="On stage" />
        {when && <span>{when}</span>}
        <span className="capitalize">{talk.kind}</span>
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {detail.video_id && (
          <a
            href={watchUrl(detail.video_id, detail.t0)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-accent-fill px-4 py-2 text-[14px] font-semibold text-on-accent hover:opacity-90"
          >
            <span aria-hidden>▶</span>
            Watch Session
          </a>
        )}
        <Link href={sessionsHref} className="inline-flex items-center rounded-lg border border-line bg-surface px-4 py-2 text-[14px] font-semibold hover:border-ink-faint">
          View all Sessions
        </Link>
        <Link href="/speakers" className="inline-flex items-center rounded-lg border border-line bg-surface px-4 py-2 text-[14px] font-semibold hover:border-ink-faint">
          View all Speakers
        </Link>
      </div>
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
      {readableDescription(talk.description) && <p className="mt-6 max-w-[72ch] text-ink-soft">{readableDescription(talk.description)}</p>}
      {tab !== "gallery" && <FrameStrip frames={frames} title={talk.title} galleryHref={`/sessions/${talk.id}?tab=gallery`} />}

      <div className="mt-6 sm:mt-10">
        <Tabs
          label="Session"
          items={[
            { href: `/sessions/${talk.id}`, label: "Claims", count: claims.length, current: tab === "claims" },
            { href: `/sessions/${talk.id}?tab=summary`, label: "Summary", current: tab === "summary" },
            { href: `/sessions/${talk.id}?tab=post`, label: "Post", current: tab === "post" },
            { href: `/sessions/${talk.id}?tab=transcript`, label: "Transcript", current: tab === "transcript" },
            { href: `/sessions/${talk.id}?tab=gallery`, label: "Gallery", count: frames.length, current: tab === "gallery" },
          ]}
        />
        {tab === "claims" &&
          (claims.length === 0 ? (
            <Empty>{NO_CLAIMS[detail.status]}</Empty>
          ) : (
            <section aria-label={`${plural(claims.length, "claim")} from this session`}>
              <ol className="space-y-3">
                {claims.map((item) => (
                  <li key={item.id}>
                    <ClaimCard item={item} hide={{ talk: true }} />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        {tab === "summary" &&
          (summary ? (
            <section aria-label="Summary" className="-mx-4 bg-sunk px-4 py-6 sm:mx-0 sm:bg-surface sm:rounded-xl sm:border sm:border-line sm:p-8">
              <Summary content={summary.summary.content} />
            </section>
          ) : (
            <Empty>{NO_SUMMARY[detail.status]}</Empty>
          ))}
        {tab === "post" && (post ? <PostCard text={post.text} /> : <Empty>{NO_POST[detail.status]}</Empty>)}
        {tab === "transcript" &&
          (turns.length > 0 ? (
            <section aria-label="Transcript">
              <ol className="space-y-8">
                {turns.map((turn) => (
                  <li key={turn.paragraphs[0]!.t0} className="sm:grid sm:grid-cols-[180px_1fr] sm:gap-6">
                    <div className="mb-2 sm:mb-0">
                      <p className="flex items-center gap-2 font-semibold leading-tight">
                        <span aria-hidden className="size-2 shrink-0 rounded-full bg-ink-faint" />
                        {turn.name ?? "Unnamed voice"}
                      </p>
                      {turn.about && <p className="mt-0.5 pl-4 text-[13px] leading-tight text-ink-soft">{turn.about}</p>}
                    </div>
                    <div className="space-y-4">
                      {turn.paragraphs.map((paragraph) => (
                        <div key={paragraph.t0} className="grid grid-cols-[48px_1fr] gap-4">
                          {detail.video_id ? (
                            <a
                              href={watchUrl(detail.video_id, paragraph.t0)}
                              target="_blank"
                              rel="noreferrer"
                              className="pt-0.5 font-mono text-[13px] tabular-nums text-ink-faint hover:text-accent"
                            >
                              {formatT(paragraph.t0 - (detail.t0 ?? 0))}
                            </a>
                          ) : (
                            <span className="pt-0.5 font-mono text-[13px] tabular-nums text-ink-faint">{formatT(paragraph.t0 - (detail.t0 ?? 0))}</span>
                          )}
                          <p className="leading-relaxed">{paragraph.text}</p>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <Empty>{detail.session_id && !heard ? "The transcript could not be loaded. Try again in a moment." : NO_TRANSCRIPT[detail.status]}</Empty>
          ))}
        {tab === "gallery" && (frames.length > 0 ? <Gallery frames={frames} title={talk.title} /> : <Empty>{NO_FRAMES[detail.status]}</Empty>)}
      </div>
    </Page>
  );
}
