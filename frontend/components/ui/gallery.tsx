import Link from "next/link";

import type { Frame } from "@/lib/api-client";
import { formatT } from "@/lib/format";

/** A session's pictures of the stage: thumbnails in time order, each opening the full image; the time opens the video there. */
export function Gallery({ frames, title }: { frames: Frame[]; title: string }) {
  return (
    <section aria-label={`Pictures from ${title}`}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {frames.map((frame) => (
          <li key={frame.id} className="group">
            <a href={frame.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line bg-sunk">
              {/* eslint-disable-next-line @next/next/no-img-element -- served by R2 as it is; next/image would proxy it through Vercel */}
              <img
                src={frame.thumb_url}
                alt={`The stage at ${formatT(frame.t)}`}
                loading="lazy"
                width={frame.width}
                height={frame.height}
                className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
              />
            </a>
            <Link href={`/video/${frame.session_id}?t=${Math.floor(frame.t)}`} className="mt-1 inline-block text-[13px] tabular-nums text-ink-soft hover:text-accent hover:underline">
              {formatT(frame.t)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
