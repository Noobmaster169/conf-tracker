"use client";

import { useState } from "react";

/** X's composer, opened with the post filled in, for whichever account the reader is signed in to. */
export const intentUrl = (text: string): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/** Characters as X counts them: a link is 23 whatever its length, an emoji is 2. */
export function xLength(text: string): number {
  const linked = text.replace(/https?:\/\/\S+/g, "x".repeat(23));
  let n = 0;
  for (const ch of linked) n += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return n - (linked.match(/️/g)?.length ?? 0);
}

/** A session's highlight post as it will read on X, with a button to post it and one to copy it. */
export function PostCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section aria-label="Post for X" className="rounded-xl border border-line bg-surface p-6 sm:p-8">
      <p className="max-w-[60ch] whitespace-pre-wrap break-words text-[15px] leading-relaxed">{text}</p>
      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <a href={intentUrl(text)} target="_blank" rel="noopener noreferrer" className="btn">
          <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 fill-current">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          Post on X
        </a>
        <button type="button" onClick={copy} className="btn btn-quiet" aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
        <span className="text-[13px] text-ink-faint">{xLength(text)} characters</span>
      </div>
    </section>
  );
}
