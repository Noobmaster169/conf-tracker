"use client";

import Link from "next/link";
import { useState } from "react";

import type { Frame } from "@/lib/api-client";
import { formatT } from "@/lib/format";
import { spread } from "@/lib/frames";

import { FrameViewer } from "./frame-viewer";

function Thumb({ frame, onOpen, className }: { frame: Frame; onOpen: () => void; className: string }) {
  return (
    <button type="button" onClick={onOpen} className={`group block overflow-hidden rounded-lg border border-line bg-sunk ${className}`} aria-label={`Open the picture at ${formatT(frame.t)}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- served by R2 as it is; next/image would proxy it through Vercel */}
      <img src={frame.thumb_url} alt="" loading="lazy" width={frame.width} height={frame.height} className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
    </button>
  );
}

/** A session's pictures of the stage: thumbnails in time order; one opens large, to download or share. */
export function Gallery({ frames, title }: { frames: Frame[]; title: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section aria-label={`Pictures from ${title}`}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {frames.map((frame, i) => (
          <li key={frame.id}>
            <Thumb frame={frame} onOpen={() => setOpen(i)} className="w-full" />
            <span className="mt-1 inline-block text-[13px] tabular-nums text-ink-soft">{formatT(frame.t)}</span>
          </li>
        ))}
      </ul>
      {open !== null && <FrameViewer frames={frames} title={title} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}

/**
 * A few of a session's pictures in one small row above its tabs, spread over the session. On a phone the row is swiped
 * sideways; wider, as many as fit side by side (four, six on a wide screen) and no scrolling. One opens large; "See all" is the Gallery tab. Nothing when there are none.
 */
export function FrameStrip({ frames, title, galleryHref, count = 6 }: { frames: Frame[]; title: string; galleryHref: string; count?: number }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = spread(frames, count);
  if (shown.length === 0) return null;
  return (
    <section aria-label={`Pictures from ${title}`} className="mt-6">
      <ul className="no-scrollbar -mx-4 flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0 lg:grid-cols-6">
        {shown.map((frame, i) => (
          <li key={frame.id} className={`shrink-0 snap-start ${i >= 4 ? "sm:max-lg:hidden" : ""}`}>
            <Thumb frame={frame} onOpen={() => setOpen(i)} className="w-40 sm:w-full" />
          </li>
        ))}
      </ul>
      {frames.length > Math.min(shown.length, 4) && (
        <Link href={galleryHref} className="mt-2 inline-block text-[14px] font-medium text-accent hover:underline">
          See all {frames.length}
        </Link>
      )}
      {open !== null && <FrameViewer frames={shown} title={title} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </section>
  );
}
