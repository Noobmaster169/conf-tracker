import Link from "next/link";
import type { ReactNode } from "react";

import type { ClaimKind } from "@/lib/api/schemas";
import { kindLabel } from "@/lib/kinds";

/** The red mark of a stage that is live right now. */
export function LiveBadge({ label = "Live" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-live-soft px-2 py-0.5 text-xs font-semibold text-live">
      <span className="live-dot size-1.5 rounded-full bg-live" />
      {label}
    </span>
  );
}

/** What kind of claim this is, as a coloured dot and a word. */
export function KindTag({ kind }: { kind: ClaimKind | null }) {
  const label = kindLabel(kind);
  if (!kind || !label) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: `var(--kind-${kind})` }}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export function PageHeader({ title, lead, children }: { title: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">{title}</h1>
        {lead && <p className="mt-1 max-w-[65ch] text-ink-soft">{lead}</p>}
      </div>
      {children}
    </div>
  );
}

/** An empty list says what will fill it. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center text-ink-soft">{children}</div>;
}

export function Page({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return <main className={`mx-auto px-4 py-8 sm:px-6 sm:py-10 ${narrow ? "max-w-[860px]" : "max-w-[1400px]"}`}>{children}</main>;
}

export interface TabItem {
  href: string;
  label: string;
  /** A count shown beside the label, the number of claims for instance. */
  count?: number;
  current: boolean;
}

/**
 * A page's sections as underlined tabs. Each tab is a link, so a tab can be shared, reloaded and opened with Back, and
 * the page renders on the server without any script.
 */
export function Tabs({ label, items }: { label: string; items: TabItem[] }) {
  return (
    <nav aria-label={label} className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1">
        {items.map((item) => (
          <li key={item.href} className="shrink-0">
            <Link
              href={item.href}
              scroll={false}
              aria-current={item.current ? "page" : undefined}
              className={`-mb-px flex min-h-11 items-center gap-2 border-b-2 px-4 font-semibold transition-colors ${
                item.current ? "border-ink text-ink" : "border-transparent text-ink-soft hover:text-ink"
              }`}
            >
              {item.label}
              {item.count !== undefined && (
                <span className={`rounded-full px-1.5 text-xs tabular-nums ${item.current ? "bg-sunk text-ink" : "bg-sunk text-ink-faint"}`}>{item.count}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
