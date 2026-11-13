import Link from "next/link";
import type { CSSProperties } from "react";

import { Empty, Page, PageHeader, Tabs } from "@/components/ui/bits";
import { listPeople, listTalks, type PersonCard } from "@/lib/api-client";
import { conferencesOf, OTHER } from "@/lib/speaker-groups";
import { initials, nameHue } from "@/lib/format";
import { photoSrc } from "@/lib/photo";

export const dynamic = "force-dynamic";

/** A speaker's photo filling a square, or, without one, their initials on a dark stage lit in the colour that is theirs. */
function Portrait({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  const src = photoSrc(photoUrl);
  if (src) {
    // A speaker photo is stored small already, or comes from wherever the admin found it, so it is a plain img.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" className="aspect-square w-full bg-sunk object-cover transition-transform duration-300 group-hover:scale-[1.03]" />;
  }
  return (
    <span aria-hidden className="portrait-blank flex aspect-square w-full items-center justify-center" style={{ "--hue": nameHue(name) } as CSSProperties}>
      <span className="portrait-blank-ring flex size-[46%] items-center justify-center rounded-full text-[clamp(1.75rem,5vw,2.75rem)] font-medium tracking-tight transition-transform duration-300 group-hover:scale-[1.04]">
        {initials(name)}
      </span>
    </span>
  );
}

export default async function SpeakersPage({ searchParams }: PageProps<"/speakers">) {
  const [people, talks, params] = await Promise.all([listPeople(), listTalks(), searchParams]);
  const groups = conferencesOf(people, talks);
  const group = groups.find((g) => g.conference === params.conference) ?? groups[0];
  return (
    <Page>
      <PageHeader title="Speakers" lead="Everyone heard on a tracked stage or named on a schedule. Open one to read their tracked claims." />
      {!group ? (
        <Empty>No speakers yet. They appear here when a schedule names them or a stream introduces them.</Empty>
      ) : (
        <>
          {groups.length > 1 && (
            <Tabs
              label="Conference"
              items={groups.map((g, i) => ({
                href: i === 0 ? "/speakers" : `/speakers?conference=${encodeURIComponent(g.conference)}`,
                label: g.conference === OTHER ? "Other speakers" : g.conference,
                count: g.people.length,
                current: g === group,
              }))}
            />
          )}
          <SpeakerGrid people={group.people} />
        </>
      )}
    </Page>
  );
}

function SpeakerGrid({ people }: { people: PersonCard[] }) {
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {people.map(({ person }) => (
        <li key={person.id}>
          <Link href={`/speakers/${person.id}`} className="group flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-ink-faint">
            <span className="block overflow-hidden">
              <Portrait name={person.name} photoUrl={person.photo_url} />
            </span>
            <span className="min-w-0 p-3 sm:p-4">
              <span className="block font-semibold leading-snug">{person.name}</span>
              {person.org && <span className="mt-0.5 block truncate text-[14px] text-ink-soft">{person.org}</span>}
              {person.title && <span className="block line-clamp-2 text-[13px] text-ink-faint">{person.title}</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
