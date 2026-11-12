import Link from "next/link";

import type { TalkCard } from "@/lib/api/views";
import { plannedTime } from "@/lib/format";

import { StatusTag } from "./bits";

/**
 * One line of a schedule: when, what, who, and whether it is past, live or still to come. A list that is not already
 * grouped by stage asks for the stage to be named too.
 */
export function TalkRow({ card, showStage = false }: { card: TalkCard; showStage?: boolean }) {
  const { talk, stage } = card;
  const names = talk.speakers.map((s) => s.name).join(", ");
  return (
    <Link href={`/sessions/${talk.id}`} className="group grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 px-4 py-4 hover:bg-sunk sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:px-5">
      <span className="pt-0.5 text-[13px] text-ink-soft">{plannedTime(talk.starts_at, talk.ends_at) ?? ""}</span>
      <span className="min-w-0">
        {showStage && <span className="mb-0.5 block truncate text-[13px] font-medium text-accent">{`${stage.conference}, ${stage.name}`}</span>}
        <span className="block font-semibold leading-snug group-hover:text-accent">{talk.title}</span>
        {names && <span className="mt-0.5 block truncate text-[13px] text-ink-soft">{names}</span>}
        {card.headline && <span className="mt-2 block max-w-[75ch] text-ink-soft">{card.headline}</span>}
      </span>
      <span className="col-start-2 mt-2 flex items-start sm:col-start-3 sm:mt-0 sm:justify-end">
        <StatusTag status={card.status} />
      </span>
    </Link>
  );
}
