import { Empty, Page, PageHeader } from "@/components/ui/bits";
import { TalkRow } from "@/components/ui/talk-row";
import { listTalks, type TalkCard } from "@/lib/api-client";
import { formatDay } from "@/lib/format";

export const dynamic = "force-dynamic";

/** The schedule arrives ordered by stage, so one pass groups it. */
function byStage(cards: TalkCard[]): { stage: TalkCard["stage"]; cards: TalkCard[] }[] {
  const groups: { stage: TalkCard["stage"]; cards: TalkCard[] }[] = [];
  for (const card of cards) {
    const last = groups.at(-1);
    if (last && last.stage.id === card.stage.id) last.cards.push(card);
    else groups.push({ stage: card.stage, cards: [card] });
  }
  return groups;
}

export default async function SessionsPage() {
  const groups = byStage(await listTalks());
  return (
    <Page>
      <PageHeader title="Sessions" lead="The schedule of every stage. A session that has finished opens to its written summary." />
      {groups.length === 0 && <Empty>No schedule yet. An admin adds a stage and its sessions from the Admin page.</Empty>}
      <div className="space-y-10">
        {groups.map(({ stage, cards }) => (
          <section key={stage.id} aria-labelledby={`stage-${stage.id}`}>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
              <h2 id={`stage-${stage.id}`} className="text-lg font-semibold">
                {stage.conference}, {stage.name}
              </h2>
              {formatDay(stage.day) && <span className="text-ink-soft">{formatDay(stage.day)}</span>}
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {cards.map((card) => (
                <li key={card.talk.id}>
                  <TalkRow card={card} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Page>
  );
}
