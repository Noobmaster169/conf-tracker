import { notFound } from "next/navigation";

import { SessionView } from "@/components/session/session-view";
import { getSnapshot } from "@/lib/api-client";
import { videoTitles } from "@/lib/video-title";

export const dynamic = "force-dynamic";

export default async function SessionPage({ params, searchParams }: PageProps<"/session/[id]">) {
  const { id } = await params;
  const { error } = await searchParams;
  const snapshot = await getSnapshot(id);
  if (!snapshot) notFound();
  // A replay names its original in the banner, so load that session and its video title.
  const replayOf = snapshot.session.replay_of;
  const originalSnapshot = replayOf ? await getSnapshot(replayOf) : null;
  const titles = originalSnapshot ? await videoTitles([originalSnapshot.session.video_id]) : {};
  const original = originalSnapshot
    ? {
        id: originalSnapshot.session.id,
        title: titles[originalSnapshot.session.video_id ?? ""]?.title ?? originalSnapshot.session.video_id ?? originalSnapshot.session.id,
        config: originalSnapshot.session.config,
      }
    : null;
  return <SessionView snapshot={snapshot} original={original} error={typeof error === "string" ? error : undefined} />;
}
