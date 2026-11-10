import Link from "next/link";

import type { VideoCard as Video } from "@/lib/api/views";
import { formatDuration, plural, thumbnailUrl } from "@/lib/format";

import { LiveBadge } from "./bits";
import { LocalTime } from "./local-time";

const isLive = (video: Video): boolean => video.session.status === "live" || video.session.status === "starting";

/** One stream: its picture, what it is, what is on stage if it is live, and how much has come out of it. */
export function VideoCard({ video }: { video: Video }) {
  const { session, stage } = video;
  const live = isLive(video);
  const title = session.title ?? (stage ? `${stage.conference}, ${stage.name}` : "Untitled video");
  return (
    <Link href={`/video/${session.id}`} className="group block overflow-hidden rounded-xl border border-line bg-surface hover:border-ink-faint">
      <div className="relative aspect-video bg-sunk">
        {session.video_id && (
          // YouTube's own still; cropped because it arrives letterboxed.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnailUrl(session.video_id)} alt="" loading="lazy" className="size-full object-cover" />
        )}
        {live ? (
          <span className="absolute left-3 top-3">
            <LiveBadge />
          </span>
        ) : (
          video.duration_s > 0 && <span className="absolute bottom-2 right-2 rounded bg-ink/85 px-1.5 py-0.5 text-xs font-medium text-white">{formatDuration(video.duration_s)}</span>
        )}
      </div>
      <div className="p-4">
        {stage && <p className="mb-1 truncate text-[13px] font-medium text-ink-soft">{`${stage.conference}, ${stage.name}`}</p>}
        <h3 className="line-clamp-2 font-semibold leading-snug group-hover:text-accent">{title}</h3>
        {live && video.now && (
          <p className="mt-2 line-clamp-1 text-[13px]">
            <span className="text-ink-soft">On stage: </span>
            <span className="font-medium">{video.now.title}</span>
          </p>
        )}
        <p className="mt-2 flex items-center justify-between text-[13px] text-ink-soft">
          <span>{plural(video.claim_count, "claim")}</span>
          <LocalTime iso={session.started_at ?? session.created_at} mode="both" />
        </p>
      </div>
    </Link>
  );
}

export { isLive };
