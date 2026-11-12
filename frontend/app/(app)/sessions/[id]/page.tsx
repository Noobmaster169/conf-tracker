import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { Empty, Page, StatusTag, Tabs } from "@/components/ui/bits";
import { ClaimCard } from "@/components/ui/claim-card";
import { FrameStrip, Gallery } from "@/components/ui/gallery";
import { PostCard } from "@/components/ui/post-card";
import { Summary } from "@/components/ui/summary";
import { getTalk, getTalkFrames } from "@/lib/api-client";
import { formatDay, formatT, plannedTime, plural, titleAndOrg } from "@/lib/format";

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

const TABS = ["claims", "summary", "post", "gallery"] as const;
type Tab = (typeof TABS)[number];
const parseTab = (value: unknown): Tab => (TABS.includes(value as Tab) ? (value as Tab) : "claims");

export default async function SessionPage({ params, searchParams }: PageProps<"/sessions/[id]">) {
  const { id } = await params;
  const tab = parseTab((await searchParams).tab);
  const [detail, frames] = await Promise.all([getTalk(id), getTalkFrames(id)]);
  if (!detail) notFound();
  const { talk, stage, summary, post, claims } = detail;
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
        <StatusTag status={detail.status} liveLabel="On stage" />
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
      {tab !== "gallery" && <FrameStrip frames={frames} title={talk.title} galleryHref={`/sessions/${talk.id}?tab=gallery`} />}

      <div className="mt-10">
        <Tabs
          label="Session"
          items={[
            { href: `/sessions/${talk.id}`, label: "Claims", count: claims.length, current: tab === "claims" },
            { href: `/sessions/${talk.id}?tab=summary`, label: "Summary", current: tab === "summary" },
            { href: `/sessions/${talk.id}?tab=post`, label: "Post", current: tab === "post" },
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
            <section aria-label="Summary" className="rounded-xl border border-line bg-surface p-6 sm:p-8">
              <Summary content={summary.summary.content} />
            </section>
          ) : (
            <Empty>{NO_SUMMARY[detail.status]}</Empty>
          ))}
        {tab === "post" && (post ? <PostCard text={post.text} /> : <Empty>{NO_POST[detail.status]}</Empty>)}
        {tab === "gallery" && (frames.length > 0 ? <Gallery frames={frames} title={talk.title} /> : <Empty>{NO_FRAMES[detail.status]}</Empty>)}
      </div>
    </Page>
  );
}
