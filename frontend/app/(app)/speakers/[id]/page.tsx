import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { Empty, Page, Tabs } from "@/components/ui/bits";
import { ClaimCard } from "@/components/ui/claim-card";
import { TalkRow } from "@/components/ui/talk-row";
import { getPerson, type FeedItem, type TalkCard } from "@/lib/api-client";
import { titleAndOrg } from "@/lib/format";

export const dynamic = "force-dynamic";

/** The events a speaker was at, the latest first, by the latest day of theirs at each. */
function eventsOf(talks: TalkCard[]): string[] {
  const last = new Map<string, string>();
  for (const { stage } of talks) {
    const day = stage.day ?? "";
    if (!last.has(stage.conference) || day > last.get(stage.conference)!) last.set(stage.conference, day);
  }
  return [...last.entries()].sort(([, a], [, b]) => b.localeCompare(a)).map(([event]) => event);
}

/** A claim's event: its session's, or else the event of a session of theirs heard in the same video. */
function eventOfClaim(claim: FeedItem, talks: TalkCard[]): string | null {
  const card = talks.find((c) => c.talk.id === claim.talk?.id) ?? talks.find((c) => c.session_id === claim.video.session_id);
  return card?.stage.conference ?? null;
}

export default async function SpeakerPage({ params, searchParams }: PageProps<"/speakers/[id]">) {
  const { id } = await params;
  const detail = await getPerson(id);
  if (!detail) notFound();
  const { person, talks, claims } = detail;

  // Claims are shown one event at a time. With nothing asked for, open on the latest event that has claims to read, or else the latest event.
  const events = eventsOf(talks);
  const asked = (await searchParams).event;
  const event =
    events.find((e) => e === asked) ?? events.find((e) => claims.some((c) => eventOfClaim(c, talks) === e)) ?? events[0] ?? null;
  const shownClaims = event && events.length > 1 ? claims.filter((c) => eventOfClaim(c, talks) === event) : claims;

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
                <TalkRow card={card} showStage />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="claims" className="mt-10">
        <h2 id="claims" className="mb-4 text-lg font-semibold">
          Tracked Claims
        </h2>
        {events.length > 1 && (
          <Tabs
            label="Event"
            items={events.map((e) => ({ href: `/speakers/${person.id}?event=${encodeURIComponent(e)}#claims`, label: e, current: e === event }))}
          />
        )}
        {shownClaims.length === 0 ? (
          <Empty>Nothing yet. Claims appear here once {person.name} has been heard and identified on a tracked stage.</Empty>
        ) : (
          <ol className="space-y-3">
            {shownClaims.map((item) => (
              <li key={item.id}>
                <ClaimCard item={item} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </Page>
  );
}
