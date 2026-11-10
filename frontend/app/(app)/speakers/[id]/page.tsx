import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { Empty, Page } from "@/components/ui/bits";
import { ClaimCard } from "@/components/ui/claim-card";
import { LocalTime } from "@/components/ui/local-time";
import { TalkRow } from "@/components/ui/talk-row";
import { getPerson } from "@/lib/api-client";
import { titleAndOrg } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SpeakerPage({ params }: PageProps<"/speakers/[id]">) {
  const { id } = await params;
  const detail = await getPerson(id);
  if (!detail) notFound();
  const { person, talks, claims } = detail;
  return (
    <Page narrow>
      <p className="mb-6 text-ink-soft">
        <Link href="/speakers" className="hover:text-accent hover:underline">
          Speakers
        </Link>
      </p>
      <header className="flex items-center gap-5">
        <Avatar name={person.name} photoUrl={person.photo_url} size="xl" />
        <div className="min-w-0">
          <h1 className="text-[32px] font-bold leading-tight tracking-tight">{person.name}</h1>
          {titleAndOrg(person) && <p className="text-[17px] text-ink-soft">{titleAndOrg(person)}</p>}
        </div>
      </header>

      {talks.length > 0 && (
        <section aria-labelledby="sessions" className="mt-10">
          <h2 id="sessions" className="mb-3 text-lg font-semibold">
            Sessions
          </h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {talks.map((card) => (
              <li key={card.talk.id}>
                <TalkRow card={card} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="claims" className="mt-10">
        <h2 id="claims" className="mb-4 text-lg font-semibold">
          What {person.name.split(" ")[0]} has claimed
        </h2>
        {claims.length === 0 ? (
          <Empty>Nothing yet. Claims appear here once {person.name} has been heard and identified on a tracked stage.</Empty>
        ) : (
          <ol className="space-y-3">
            {claims.map((item) => (
              <li key={item.id}>
                <ClaimCard item={item} hide={{ who: true }} aside={<LocalTime iso={item.created_at} mode="both" />} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </Page>
  );
}
