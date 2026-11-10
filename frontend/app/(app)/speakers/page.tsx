import Link from "next/link";

import { Avatar } from "@/components/ui/avatar";
import { Empty, Page, PageHeader } from "@/components/ui/bits";
import { listPeople } from "@/lib/api-client";
import { plural, titleAndOrg } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SpeakersPage() {
  const people = await listPeople();
  return (
    <Page>
      <PageHeader title="Speakers" lead="Everyone heard on a tracked stage or named on a schedule. Open one to read everything they have claimed." />
      {people.length === 0 && <Empty>No speakers yet. They appear here when a schedule names them or a stream introduces them.</Empty>}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {people.map(({ person, claim_count, talk_count }) => (
          <li key={person.id}>
            <Link href={`/speakers/${person.id}`} className="group flex h-full items-center gap-4 rounded-xl border border-line bg-surface p-4 hover:border-ink-faint">
              <Avatar name={person.name} photoUrl={person.photo_url} size="lg" />
              <span className="min-w-0">
                <span className="block truncate font-semibold group-hover:text-accent">{person.name}</span>
                <span className="block truncate text-[13px] text-ink-soft">{titleAndOrg(person) ?? " "}</span>
                <span className="mt-1.5 block text-[13px] text-ink-soft">
                  {plural(claim_count, "claim")}
                  {talk_count > 0 && `, ${plural(talk_count, "session")}`}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
