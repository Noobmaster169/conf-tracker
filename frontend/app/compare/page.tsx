import Link from "next/link";

import { type CompareSide, CompareView } from "@/components/compare/compare-view";
import { Nav } from "@/components/nav";
import { getClaims, getSnapshot, getTranscript, type Snapshot } from "@/lib/api-client";
import { speakerRuns } from "@/lib/compare";
import { speakerResolver } from "@/lib/session-state";
import { videoTitles } from "@/lib/video-title";

export const dynamic = "force-dynamic";

/**
 * One side, whole: the snapshot keeps only the newest segments and claims, so those come from their own routes. The
 * strip's runs are worked out here, which keeps every segment's words out of the page payload.
 */
async function loadSide(snapshot: Snapshot): Promise<CompareSide> {
  const { session, speakers, cost_usd } = snapshot;
  const segments = await getTranscript(session.id);
  const endS = segments.reduce((end, s) => Math.max(end, s.t1), 0);
  const claims = await getClaims(session.id, endS);
  return { session, speakers, cost_usd, claims, endS, runs: speakerRuns(segments, speakerResolver(speakers)) };
}

export default async function ComparePage({ searchParams }: PageProps<"/compare">) {
  const { a, b } = await searchParams;
  const [left, right] = typeof a === "string" && typeof b === "string" ? await Promise.all([getSnapshot(a), getSnapshot(b)]) : [null, null];
  if (!left || !right) {
    return (
      <>
        <Nav current="sessions" />
        <main className="mx-auto max-w-3xl p-6 text-ink-dim">
          Pick two sessions to compare. <Link href="/" className="text-accent">Sessions</Link>
        </main>
      </>
    );
  }
  const [titles, sideA, sideB] = await Promise.all([videoTitles([left.session.video_id, right.session.video_id]), loadSide(left), loadSide(right)]);
  const titleOf = (s: typeof left.session) => titles[s.video_id ?? ""]?.title ?? s.video_id ?? s.source_file ?? s.id;
  return (
    <>
      <Nav current="sessions" />
      <CompareView a={sideA} b={sideB} titles={{ a: titleOf(left.session), b: titleOf(right.session) }} />
    </>
  );
}
