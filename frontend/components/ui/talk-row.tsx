import Link from "next/link";

import type { TalkCard } from "@/lib/api/views";
import { plannedTime, plural } from "@/lib/format";

import { LiveBadge } from "./bits";

/** One line of a schedule: when, what, who, and what came of it once it has been on stage. */
export function TalkRow({ card }: { card: TalkCard }) {
  const { talk } = card;
  const names = talk.speakers.map((s) => s.name).join(", ");
  return (
    <Link href={`/sessions/${talk.id}`} className="group grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 px-4 py-4 hover:bg-paper sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:px-5">
      <span className="pt-0.5 text-[13px] text-ink-soft">{plannedTime(talk.starts_at, talk.ends_at) ?? ""}</span>
      <span className="min-w-0">
        <span className="block font-semibold leading-snug group-hover:text-accent">{talk.title}</span>
        {names && <span className="mt-0.5 block truncate text-[13px] text-ink-soft">{names}</span>}
        {card.headline && <span className="mt-2 block max-w-[75ch] text-ink-soft">{card.headline}</span>}
      </span>
      <span className="col-start-2 mt-2 flex items-start gap-3 text-[13px] text-ink-soft sm:col-start-3 sm:mt-0 sm:justify-end">
        {card.status === "live" && <LiveBadge label="On stage" />}
        {card.status === "upcoming" && <span className="text-ink-faint">Not yet on stage</span>}
        {card.status !== "upcoming" && card.claim_count > 0 && <span>{plural(card.claim_count, "claim")}</span>}
      </span>
    </Link>
  );
}
