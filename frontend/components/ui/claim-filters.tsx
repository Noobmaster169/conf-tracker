import Link from "next/link";

import type { ClaimKind } from "@/lib/api/schemas";
import { KINDS } from "@/lib/kinds";

/** One option of the claim filter, the same on the Monitor (a button) and a session page (a link). */
export const chipClass = (active: boolean): string =>
  `rounded-full border px-3 py-1 text-sm font-medium ${active ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface text-ink-soft hover:text-ink"}`;

export type ClaimFilter = { kind: ClaimKind | null; major: boolean };

/** The filter as it is read from a page's query: an unknown kind is no kind. */
export function parseClaimFilter(params: Record<string, string | string[] | undefined>): ClaimFilter {
  const kind = KINDS.find((k) => k.kind === params.kind)?.kind ?? null;
  return { kind, major: params.major === "1" };
}

/**
 * The claim filter as links, for a page rendered on the server: each option is a URL, so a filtered list can be shared
 * and reloaded. `href` builds the page's URL for a filter.
 */
export function ClaimFilterLinks({ filter, href }: { filter: ClaimFilter; href: (filter: ClaimFilter) => string }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      <Link href={href({ ...filter, kind: null })} scroll={false} aria-current={filter.kind === null ? "true" : undefined} className={chipClass(filter.kind === null)}>
        Everything
      </Link>
      {KINDS.map(({ kind, plural }) => (
        <Link key={kind} href={href({ ...filter, kind })} scroll={false} aria-current={filter.kind === kind ? "true" : undefined} className={chipClass(filter.kind === kind)}>
          {plural}
        </Link>
      ))}
      <Link
        href={href({ ...filter, major: !filter.major })}
        scroll={false}
        role="checkbox"
        aria-checked={filter.major}
        className="ml-auto flex items-center gap-2 text-sm text-ink-soft hover:text-ink"
      >
        <span aria-hidden className={`grid size-4 place-items-center rounded border text-[11px] leading-none ${filter.major ? "border-accent bg-accent-fill text-on-accent" : "border-ink-faint"}`}>
          {filter.major ? "✓" : ""}
        </span>
        Major only
      </Link>
    </div>
  );
}
