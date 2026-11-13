import Link from "next/link";

import { Empty, Page, PageHeader } from "@/components/ui/bits";
import { TalkRow } from "@/components/ui/talk-row";
import { listTalks, type TalkCard } from "@/lib/api-client";
import { formatDay } from "@/lib/format";

export const dynamic = "force-dynamic";

type Stage = TalkCard["stage"];
type StageGroup = { stage: Stage; cards: TalkCard[] };
type DayGroup = { day: string; stages: StageGroup[] };

const NO_DAY = "undated";

/** The schedule arrives ordered by stage, so one pass groups it by stage, and the stages by the day they run. Within a
 * day the busiest stage (the main one) comes first, so it is also the one a day opens to. */
function byDay(cards: TalkCard[]): DayGroup[] {
  const days = new Map<string, Map<string, StageGroup>>();
  for (const card of cards) {
    const day = card.stage.day ?? NO_DAY;
    const stages = days.get(day) ?? new Map<string, StageGroup>();
    days.set(day, stages);
    const group = stages.get(card.stage.id) ?? { stage: card.stage, cards: [] };
    stages.set(card.stage.id, group);
    group.cards.push(card);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a === NO_DAY ? 1 : b === NO_DAY ? -1 : a.localeCompare(b)))
    .map(([day, stages]) => ({
      day,
      stages: [...stages.values()].sort((a, b) => b.cards.length - a.cards.length || a.stage.name.localeCompare(b.stage.name)),
    }));
}

const isLive = (cards: TalkCard[]) => cards.some((c) => c.status === "live");

/** With nothing asked for, open where something is on: a live stage, then today, then the next day to come, then the last. */
function defaultDay(days: DayGroup[]): DayGroup | undefined {
  const today = new Date().toISOString().slice(0, 10);
  return (
    days.find((d) => d.stages.some((s) => isLive(s.cards))) ??
    days.find((d) => d.day === today) ??
    days.find((d) => d.day !== NO_DAY && d.day > today) ??
    days.at(-1)
  );
}

function dayLabel(day: string): { weekday: string; date: string } {
  const formatted = formatDay(day === NO_DAY ? null : day);
  if (!formatted) return { weekday: "", date: "No date" };
  const [weekday, day_, month] = formatted.replace(",", "").split(" ");
  return { weekday, date: `${day_} ${month}` };
}

const href = (day: string, stage?: string) => `/sessions?day=${encodeURIComponent(day)}${stage ? `&stage=${encodeURIComponent(stage)}` : ""}`;

function LiveDot({ onFill = false }: { onFill?: boolean }) {
  return <span aria-label="live" className={`live-dot size-2 shrink-0 rounded-full ${onFill ? "bg-on-accent" : "bg-live"}`} />;
}

export default async function SessionsPage({ searchParams }: PageProps<"/sessions">) {
  const params = await searchParams;
  const days = byDay(await listTalks());
  const day = days.find((d) => d.day === params.day) ?? defaultDay(days);
  const stage = day?.stages.find((s) => s.stage.id === params.stage) ?? day?.stages.find((s) => isLive(s.cards)) ?? day?.stages[0];

  return (
    <Page>
      <PageHeader title="Sessions" lead="Every stage, day by day. Open a session for its claims, summary and pictures." />
      {!day || !stage ? (
        <Empty>No schedule yet. An admin adds a stage and its sessions from the Admin page.</Empty>
      ) : (
        <>
          <nav aria-label="Day" className="no-scrollbar -mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:overflow-visible sm:px-0">
            <ul className="flex gap-2 sm:flex-wrap">
              {days.map((d) => {
                const { weekday, date } = dayLabel(d.day);
                const current = d.day === day.day;
                return (
                  <li key={d.day} className="shrink-0">
                    <Link
                      href={href(d.day)}
                      aria-current={current ? "page" : undefined}
                      className={`flex min-w-[8.5rem] flex-col rounded-xl border px-4 py-2.5 transition-colors ${
                        current ? "border-accent-fill bg-accent-fill text-on-accent" : "border-line bg-surface hover:border-ink-faint"
                      }`}
                    >
                      <span className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${current ? "opacity-80" : "text-ink-soft"}`}>
                        {weekday}
                        {d.stages.some((s) => isLive(s.cards)) && <LiveDot onFill={current} />}
                      </span>
                      <span className="text-[17px] font-semibold leading-tight">{date}</span>
                      <span className={`mt-0.5 max-w-[14rem] truncate text-[12px] ${current ? "opacity-80" : "text-ink-faint"}`}>{d.stages[0].stage.conference}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <nav aria-label="Stage" className="no-scrollbar -mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:overflow-visible sm:px-0">
            <ul className="flex gap-1 sm:flex-wrap">
              {day.stages.map((s) => {
                const current = s.stage.id === stage.stage.id;
                return (
                  <li key={s.stage.id} className="shrink-0">
                    <Link
                      href={href(day.day, s.stage.id)}
                      aria-current={current ? "page" : undefined}
                      className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 font-semibold sm:px-4 transition-colors ${
                        current ? "border-ink text-ink" : "border-transparent text-ink-soft hover:text-ink"
                      }`}
                    >
                      {isLive(s.cards) && <LiveDot />}
                      {s.stage.name}
                      <span className={`rounded-full px-1.5 text-xs ${current ? "bg-sunk text-ink" : "bg-sunk text-ink-faint"}`}>{s.cards.length}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <section aria-label={`${stage.stage.conference}, ${stage.stage.name}`}>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {stage.cards.map((card) => (
                <li key={card.talk.id}>
                  <TalkRow card={card} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Page>
  );
}
