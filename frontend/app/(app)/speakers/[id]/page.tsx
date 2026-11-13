import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { Empty, Page } from "@/components/ui/bits";
import { ClaimCard } from "@/components/ui/claim-card";
import { TalkRow } from "@/components/ui/talk-row";
import { getPerson, type FeedItem, type TalkCard } from "@/lib/api-client";
import { formatDay, titleAndOrg } from "@/lib/format";

export const dynamic = "force-dynamic";

/** A session's claims shown on the speaker's page before "See all" sends the reader to the session itself. */
const CLAIMS_PER_SESSION = 3;

type Appearance = { card: TalkCard; claims: FeedItem[] };
type Event = { conference: string; firstDay: string | null; appearances: Appearance[] };

/**
 * A speaker's sessions grouped by the event they were at, the latest event first, each session carrying the claims
 * made in it. Claims heard outside any of their scheduled sessions are left over and listed apart.
 */
function byEvent(talks: TalkCard[], claims: FeedItem[]): { events: Event[]; loose: FeedItem[] } {
  const claimsOf = new Map<number, FeedItem[]>();
  const loose: FeedItem[] = [];
  const known = new Set(talks.map((c) => c.talk.id));
  for (const claim of claims) {
    if (claim.talk && known.has(claim.talk.id)) {
      const list = claimsOf.get(claim.talk.id) ?? [];
      list.push(claim);
      claimsOf.set(claim.talk.id, list);
    } else loose.push(claim);
  }
  const events = new Map<string, Event>();
  for (const card of talks) {
    const key = card.stage.conference;
    const event = events.get(key) ?? { conference: key, firstDay: card.stage.day, appearances: [] };
    events.set(key, event);
    if (card.stage.day && (!event.firstDay || card.stage.day < event.firstDay)) event.firstDay = card.stage.day;
    event.appearances.push({ card, claims: (claimsOf.get(card.talk.id) ?? []).sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0)) });
  }
  const when = (c: TalkCard) => `${c.stage.day ?? ""} ${c.talk.starts_at ?? ""}`;
  for (const event of events.values()) event.appearances.sort((a, b) => when(a.card).localeCompare(when(b.card)));
  return { events: [...events.values()].sort((a, b) => (b.firstDay ?? "").localeCompare(a.firstDay ?? "")), loose };
}

const anchor = (conference: string) => `event-${conference.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export default async function SpeakerPage({ params }: PageProps<"/speakers/[id]">) {
  const { id } = await params;
  const detail = await getPerson(id);
  if (!detail) notFound();
  const { person, talks, claims } = detail;
  const { events, loose } = byEvent(talks, claims);
  return (
    <Page narrow>
      <header className="flex items-center gap-4 sm:gap-5">
        <Avatar name={person.name} photoUrl={person.photo_url} size="xl" />
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-tight tracking-tight sm:text-[32px]">{person.name}</h1>
          {titleAndOrg(person) && <p className="text-[16px] text-ink-soft sm:text-[17px]">{titleAndOrg(person)}</p>}
        </div>
      </header>

      {events.length > 1 && (
        <nav aria-label="Events" className="no-scrollbar -mx-4 mt-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ul className="flex gap-2">
            {events.map((event) => (
              <li key={event.conference} className="shrink-0">
                <a href={`#${anchor(event.conference)}`} className="block rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-soft hover:border-ink-faint hover:text-ink">
                  {event.conference}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {events.length === 0 && loose.length === 0 && (
        <div className="mt-10">
          <Empty>Nothing yet. Sessions and claims appear here once {person.name} is on a tracked stage.</Empty>
        </div>
      )}

      {events.map((event) => (
        <section key={event.conference} id={anchor(event.conference)} aria-labelledby={`${anchor(event.conference)}-h`} className="mt-8 scroll-mt-20 sm:mt-10">
          <h2 id={`${anchor(event.conference)}-h`} className="text-lg font-semibold">
            {event.conference}
          </h2>
          {formatDay(event.firstDay) && <p className="text-[14px] text-ink-soft">{formatDay(event.firstDay)}</p>}
          <ul className="mt-3 space-y-4">
            {event.appearances.map(({ card, claims: said }) => (
              <li key={card.talk.id} className="overflow-hidden rounded-xl border border-line bg-surface">
                <TalkRow card={card} showStage />
                {said.length > 0 && (
                  <div className="border-t border-line bg-sunk/40 px-4 py-4 sm:px-5">
                    <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-ink-soft">What {person.name.split(" ")[0]} said</h3>
                    <ol className="space-y-3">
                      {said.slice(0, CLAIMS_PER_SESSION).map((item) => (
                        <li key={item.id}>
                          <ClaimCard item={item} hide={{ who: true, talk: true }} />
                        </li>
                      ))}
                    </ol>
                    {said.length > CLAIMS_PER_SESSION && (
                      <Link href={`/sessions/${card.talk.id}`} className="mt-3 inline-block text-[14px] font-medium text-accent hover:underline">
                        See all claims from this session ›
                      </Link>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {loose.length > 0 && (
        <section aria-labelledby="other" className="mt-8 sm:mt-10">
          <h2 id="other" className="text-lg font-semibold">
            Other appearances
          </h2>
          <p className="text-[14px] text-ink-soft">Heard on a tracked stage outside a scheduled session.</p>
          <ol className="mt-3 space-y-3">
            {loose.map((item) => (
              <li key={item.id}>
                <ClaimCard item={item} hide={{ who: true }} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </Page>
  );
}
