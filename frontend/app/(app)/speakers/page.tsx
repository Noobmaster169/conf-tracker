import Link from "next/link";
import type { CSSProperties } from "react";

import { Empty, Page, PageHeader } from "@/components/ui/bits";
import { listPeople } from "@/lib/api-client";
import { initials, nameHue } from "@/lib/format";
import { photoSrc } from "@/lib/photo";

export const dynamic = "force-dynamic";

/** A speaker's photo filling a square, or their initials large on the colour that is always theirs. */
function Portrait({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  const src = photoSrc(photoUrl);
  if (src) {
    // A speaker photo is stored small already, or comes from wherever the admin found it, so it is a plain img.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" className="aspect-square w-full bg-sunk object-cover transition-transform duration-300 group-hover:scale-[1.03]" />;
  }
  return (
    <span aria-hidden className="avatar-initials flex aspect-square w-full items-center justify-center text-5xl font-semibold" style={{ "--hue": nameHue(name) } as CSSProperties}>
      {initials(name)}
    </span>
  );
}

export default async function SpeakersPage() {
  const people = await listPeople();
  return (
    <Page>
      <PageHeader title="Speakers" lead="Everyone heard on a tracked stage or named on a schedule. Open one to read everything they have claimed." />
      {people.length === 0 && <Empty>No speakers yet. They appear here when a schedule names them or a stream introduces them.</Empty>}
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {people.map(({ person }) => (
          <li key={person.id}>
            <Link href={`/speakers/${person.id}`} className="group flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface hover:border-ink-faint">
              <span className="block overflow-hidden">
                <Portrait name={person.name} photoUrl={person.photo_url} />
              </span>
              <span className="min-w-0 p-3 sm:p-4">
                <span className="block font-semibold leading-snug group-hover:text-accent">{person.name}</span>
                {person.org && <span className="mt-0.5 block truncate text-[14px]">{person.org}</span>}
                {person.title && <span className="block line-clamp-2 text-[13px] text-ink-soft">{person.title}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
