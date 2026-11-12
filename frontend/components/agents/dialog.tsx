import Link from "next/link";
import type { ReactNode } from "react";

/** A window over the page that is part of the address: opening it is a link, and so is closing it. */
export function Dialog({ title, sub, closeHref, children, wide = false }: { title: ReactNode; sub?: ReactNode; closeHref: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:items-center sm:p-6">
      <Link href={closeHref} scroll={false} aria-label="Close" className="fixed inset-0 cursor-default" />
      <div role="dialog" aria-modal="true" className={`relative flex max-h-full w-full min-w-0 flex-col rounded-2xl border border-line bg-surface shadow-2xl ${wide ? "max-w-[1040px]" : "max-w-[820px]"}`}>
        <header className="flex items-start gap-3 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-[17px] font-semibold leading-snug">{title}</h2>
            {sub && <p className="mt-0.5 text-[13px] text-ink-soft">{sub}</p>}
          </div>
          <Link href={closeHref} scroll={false} className="btn btn-quiet shrink-0">
            Close
          </Link>
        </header>
        <div className="min-w-0 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
      </div>
    </div>
  );
}
