import { notFound } from "next/navigation";

import { VideoView } from "@/components/video/video-view";
import { getFeed, getSnapshot, getTranscript, type FeedItem } from "@/lib/api-client";

export const dynamic = "force-dynamic";

// A stage day runs to a few hundred claims; this is a ceiling on a runaway, not a page size anyone reaches.
const MAX_CLAIM_PAGES = 25;

/** Every verified claim of a video, oldest first: the snapshot carries only the newest few. */
async function allClaims(id: string): Promise<FeedItem[]> {
  const items: FeedItem[] = [];
  let before: number | null = null;
  for (let page = 0; page < MAX_CLAIM_PAGES; page++) {
    const feed = await getFeed(`session=${id}&limit=200${before === null ? "" : `&before=${before}`}`);
    items.push(...feed.items);
    before = feed.next_before;
    if (before === null) break;
  }
  return items.reverse();
}

export default async function VideoPage({ params, searchParams }: PageProps<"/video/[id]">) {
  const { id } = await params;
  const { t } = await searchParams;
  const snapshot = await getSnapshot(id);
  if (!snapshot) notFound();
  const live = snapshot.session.status === "live" || snapshot.session.status === "starting" || snapshot.session.status === "recovering";
  // A finished video is read from the top, so it gets all of its transcript; a live one opens at its newest lines.
  const [segments, claims] = await Promise.all([live ? snapshot.segments : getTranscript(id), allClaims(id)]);
  const start = typeof t === "string" && /^\d+$/.test(t) ? Number(t) : null;
  return <VideoView snapshot={{ ...snapshot, segments, claims }} start={start} />;
}
