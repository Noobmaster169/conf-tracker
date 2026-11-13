import Link from "next/link";

import type { TalkCard } from "@/lib/api/views";
import { formatDay, plannedTime } from "@/lib/format";

import { StatusTag } from "./bits";

/**
 * One line of a schedule: when, what, who, and whether it is past, live or still to come. The whole row opens the
 * session; "View details" says so in words, so nobody has to guess the row is a link. A list not already grouped by
 * stage asks for the stage to be named too.
 */
export function TalkRow({ card, showStage = false }: { card: TalkCard; showStage?: boolean }) {
  const { talk, stage } = card;
  const names = talk.speakers.map((s) => s.name).join(", ");
  const time = plannedTime(talk.starts_at, talk.ends_at);
  // A list over several days (a speaker's sessions) says which day too; the schedule has picked the day already.
  const date = showStage ? formatDay(stage.day) : null;
  return (
    <Link
      href={`/sessions/${talk.id}`}
      className={`group grid grid-cols-1 gap-x-5 px-4 py-4 transition-colors hover:bg-sunk ${showStage ? "sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]" : "sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]"} sm:px-5`}
    >
      <span className="mb-1 text-[13px] text-ink-soft sm:mb-0 sm:pt-0.5">
        {date && (
          <span className="sm:block">
            {date}
            {time && <span className="sm:hidden"> · </span>}
          </span>
        )}
        {time ?? ""}
      </span>
      <span className="min-w-0">
        {showStage && <span className="mb-0.5 block truncate text-[13px] font-medium text-accent">{`${stage.conference}, ${stage.name}`}</span>}
        <span className="block font-semibold leading-snug group-hover:text-accent">{talk.title}</span>
        {names && <span className="mt-0.5 block truncate text-[13px] text-ink-soft">{names}</span>}
        {card.headline && <span className="mt-2 block max-w-[75ch] text-ink-soft">{card.headline}</span>}
      </span>
      <span className="mt-3 flex items-center justify-between gap-3 sm:mt-0 sm:flex-col sm:items-end sm:justify-between">
        <StatusTag status={card.status} />
        <span className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors group-hover:border-accent group-hover:text-accent">
          View details
          <span aria-hidden>›</span>
        </span>
      </span>
    </Link>
  );
}
