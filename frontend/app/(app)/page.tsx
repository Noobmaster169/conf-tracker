import Link from "next/link";

import { MonitorFeed } from "@/components/monitor-feed";
import { LiveRefresh } from "@/components/monitor/live-refresh";
import { StageCard } from "@/components/monitor/stage-card";
import { Empty, Page } from "@/components/ui/bits";
import { FEED_CACHE_S, getFeed, listVideos, SETTLED_CACHE_S } from "@/lib/api-client";
import { formatDay } from "@/lib/format";
import { defaultDay, feedScope, monitorDays, monitorHref } from "@/lib/monitor";

export const dynamic = "force-dynamic";

function dayLabel(day: string): { weekday: string; date: string } {
  const formatted = formatDay(day);
  if (!formatted) return { weekday: "", date: day };
  const [weekday, day_, month] = formatted.replace(",", "").split(" ");
  return { weekday, date: `${day_} ${month}` };
}

function Pill({ href, current, live = false, children }: { href: string; current: boolean; live?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={current ? "page" : undefined}
      className={`flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
        current ? "border-ink bg-ink text-surface" : "border-line bg-surface text-ink-soft hover:text-ink"
      }`}
    >
      {live && <span aria-label="live" className="live-dot size-1.5 rounded-full bg-live" />}
      {children}
    </Link>
  );
}

/**
 * The Monitor, and the app's front page: a day at a time, its stages on the left (what is on, and the newest picture of
 * each) and what was claimed on them on the right. A day that has ended is read from a long-lived cache and never polled;
 * a live day refreshes its stages and polls its claims.
 */
export default async function MonitorPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const days = monitorDays(await listVideos());
  const day = days.find((d) => d.day === params.day) ?? defaultDay(days);
  if (!day) {
    return (
      <Page>
        <Empty>Nothing tracked yet. An admin starts a stage&apos;s stream from the Admin page.</Empty>
      </Page>
    );
  }
  const picked = day.groups.find((g) => g.key === params.stage) ?? null;
  const shown = picked ? [picked] : day.groups;
  const live = shown.some((g) => g.live);
  const scope = feedScope(day.day, picked);
  const initial = await getFeed(new URLSearchParams(scope).toString(), live ? FEED_CACHE_S : SETTLED_CACHE_S);

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
      {live && <LiveRefresh />}
      <nav aria-label="Day" className="no-scrollbar -mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex gap-2">
          {days.map((d) => {
            const { weekday, date } = dayLabel(d.day);
            const current = d.day === day.day;
            return (
              <li key={d.day} className="shrink-0">
                <Link
                  href={monitorHref(d.day)}
                  aria-current={current ? "page" : undefined}
                  className={`flex min-w-[7rem] flex-col rounded-xl border px-4 py-2 transition-colors ${
                    current ? "border-accent-fill bg-accent-fill text-on-accent" : "border-line bg-surface hover:border-ink-faint"
                  }`}
                >
                  <span className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${current ? "opacity-80" : "text-ink-soft"}`}>
                    {weekday}
                    {d.live && <span aria-label="live" className={`live-dot size-2 rounded-full ${current ? "bg-on-accent" : "bg-live"}`} />}
                  </span>
                  <span className="text-[17px] font-semibold leading-tight">{date}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {day.groups.length > 1 && (
        <nav aria-label="Stage" className="no-scrollbar -mx-4 mb-6 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ul className="flex gap-2">
            <li>
              <Pill href={monitorHref(day.day)} current={!picked}>
                All stages
              </Pill>
            </li>
            {day.groups.map((g) => (
              <li key={g.key}>
                <Pill href={monitorHref(day.day, g.key)} current={picked?.key === g.key} live={g.live}>
                  {g.name}
                </Pill>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8">
        <aside aria-label="Stages" className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto">
          <div className={`grid gap-5 ${shown.length > 1 ? "grid-cols-2 lg:grid-cols-1" : ""}`}>
            {shown.map((g) => (
              <StageCard key={g.key} group={g} compact={shown.length > 1} />
            ))}
          </div>
        </aside>
        <section aria-label="Claims" className="min-w-0">
          <MonitorFeed key={`${day.day}|${picked?.key ?? "all"}`} initial={initial} scope={scope} live={live} />
        </section>
      </div>
    </main>
  );
}
