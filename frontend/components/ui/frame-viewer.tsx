"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Frame } from "@/lib/api-client";
import { formatT } from "@/lib/format";
import { frameDownloadUrl, frameFileName } from "@/lib/frames";

/**
 * One frame large, over the page: its time (opening the video there), Download, and on a phone Share (the share sheet,
 * with the image attached: Save Image, or straight to the X app). Arrows, a swipe or the keyboard move through the list;
 * Esc or a click outside closes it.
 */
export function FrameViewer({ frames, title, index, onIndex, onClose }: { frames: Frame[]; title: string; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const touchX = useRef<number | null>(null);
  // Sharing a file is a phone thing (a desktop that offers it too is fine). The viewer mounts only after a click, never
  // on the server, so navigator is there.
  const [canShare] = useState(() => typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([], "x.webp", { type: "image/webp" })] }));
  const [sharing, setSharing] = useState(false);
  const frame = frames[index]!;
  const name = frameFileName(title, frame.t);
  const download = frameDownloadUrl(frame.url, name);

  const step = useCallback((by: number) => onIndex((index + by + frames.length) % frames.length), [index, frames.length, onIndex]);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const share = async () => {
    setSharing(true);
    try {
      const blob = await (await fetch(download)).blob();
      await navigator.share({ files: [new File([blob], name, { type: "image/webp" })], title });
    } catch {
      // Closed the sheet, or the share failed: nothing to say, Download is beside it.
    } finally {
      setSharing(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      aria-label={`Picture from ${title} at ${formatT(frame.t)}`}
      className="m-auto w-[min(100vw-2rem,1100px)] max-w-none rounded-xl bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/70"
    >
      <div
        className="relative bg-black"
        onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          touchX.current = null;
          if (start !== null && end !== undefined && Math.abs(end - start) > 40) step(end < start ? 1 : -1);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- served by R2 as it is; next/image would proxy it through Vercel */}
        <img src={frame.url} alt={`The stage at ${formatT(frame.t)}`} width={frame.width} height={frame.height} className="mx-auto max-h-[75vh] w-auto" />
        {frames.length > 1 && (
          <>
            <button type="button" onClick={() => step(-1)} aria-label="Previous picture" className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/50 px-3 py-2 text-white hover:bg-black/70 sm:block">
              ‹
            </button>
            <button type="button" onClick={() => step(1)} aria-label="Next picture" className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/50 px-3 py-2 text-white hover:bg-black/70 sm:block">
              ›
            </button>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Link href={`/video/${frame.session_id}?t=${Math.floor(frame.t)}`} className="text-[14px] tabular-nums text-ink-soft hover:text-accent hover:underline">
          {formatT(frame.t)}
        </Link>
        {frames.length > 1 && (
          <span className="text-[13px] tabular-nums text-ink-faint">
            {index + 1} / {frames.length}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {canShare && (
            <button type="button" onClick={share} disabled={sharing} className="btn">
              {sharing ? "Opening…" : "Share"}
            </button>
          )}
          <a href={download} download={name} className={canShare ? "btn btn-quiet" : "btn"}>
            Download
          </a>
          <button type="button" onClick={() => dialog.current?.close()} className="btn btn-quiet">
            Close
          </button>
        </span>
      </div>
    </dialog>
  );
}
