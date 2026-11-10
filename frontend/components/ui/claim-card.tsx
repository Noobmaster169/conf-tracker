import Link from "next/link";
import type { ReactNode } from "react";

import type { FeedItem } from "@/lib/api/views";
import { formatT, titleAndOrg } from "@/lib/format";
import { isMajor } from "@/lib/kinds";

import { Avatar } from "./avatar";
import { KindTag } from "./bits";

/** Who said it: the person when the voice is known, the name alone when it is not a person yet, and a plain mark otherwise. */
function Who({ item }: { item: FeedItem }) {
  const name = item.person?.name ?? item.speaker_name;
  const about = item.person ? titleAndOrg(item.person) : null;
  const body = (
    <>
      <Avatar name={name} photoUrl={item.person?.photo_url} />
      <span className="min-w-0">
        <span className="block truncate font-semibold leading-tight">{name ?? "Unidentified speaker"}</span>
        {about && <span className="block truncate text-[13px] leading-tight text-ink-soft">{about}</span>}
      </span>
    </>
  );
  return item.person ? (
    <Link href={`/speakers/${item.person.id}`} className="flex min-w-0 items-center gap-2.5 hover:text-accent">
      {body}
    </Link>
  ) : (
    <span className="flex min-w-0 items-center gap-2.5">{body}</span>
  );
}

export interface ClaimCardProps {
  item: FeedItem;
  /** Leave out what the page already says: a speaker's page does not repeat the speaker, a session's page the session. */
  hide?: { who?: boolean; talk?: boolean; video?: boolean };
  /** Shown at the right of the header, a time for instance. */
  aside?: ReactNode;
}

/**
 * One claim: who said it, what they claimed, and their own words underneath. The claim is the largest thing on the
 * card because it is the thing being read; a claim rated as news carries a blue edge.
 */
export function ClaimCard({ item, hide = {}, aside }: ClaimCardProps) {
  const at = item.t0 === null ? "" : `?t=${Math.floor(item.t0)}`;
  return (
    <article className={`rounded-xl border bg-surface p-4 sm:p-5 ${isMajor(item.importance) ? "border-line border-l-[3px] border-l-accent" : "border-line"}`}>
      {(!hide.who || aside) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {hide.who ? <span /> : <Who item={item} />}
          {aside && <span className="shrink-0 text-[13px] text-ink-faint">{aside}</span>}
        </header>
      )}
      <p className="text-[17px] font-medium leading-snug">{item.claim}</p>
      <blockquote className="mt-2 border-l-2 border-line pl-3 text-ink-soft">&ldquo;{item.quote}&rdquo;</blockquote>
      <footer className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-soft">
        <KindTag kind={item.kind} />
        {!hide.talk && item.talk && (
          <Link href={`/sessions/${item.talk.id}`} className="hover:text-accent hover:underline">
            {item.talk.title}
          </Link>
        )}
        {!hide.video && (
          <Link href={`/video/${item.video.session_id}${at}`} className="hover:text-accent hover:underline">
            {item.t0 === null ? "Watch" : `Watch at ${formatT(item.t0)}`}
          </Link>
        )}
      </footer>
    </article>
  );
}
