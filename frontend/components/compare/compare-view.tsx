"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { AuditDrawer } from "@/components/session/audit-drawer";
import type { Claim, Snapshot } from "@/lib/api/schemas";
import { type ClaimPair, configDiff, formatSetting, matchClaims, pairT0, sameAudio, type SpeakerRun } from "@/lib/compare";
import { formatT } from "@/lib/format";
import { speakerLabeller } from "@/lib/speaker-names";

import { SpeakerStrip, TimeAxis } from "./speaker-strip";

type Side = "a" | "b";
type Filter = "all" | "matched" | "a" | "b";
type Target = { side: Side; callId: number; claimId: number };
/** A session in full: every claim, and the speaker runs over every segment (the snapshot holds only the newest). */
export type CompareSide = Pick<Snapshot, "session" | "speakers" | "cost_usd"> & { claims: Claim[]; runs: SpeakerRun[]; endS: number };
type Props = { a: CompareSide; b: CompareSide; titles: { a: string; b: string } };

const FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "matched", label: "matched" },
  { key: "a", label: "only A" },
  { key: "b", label: "only B" },
];

const kindOf = (pair: ClaimPair): Exclude<Filter, "all"> => (pair.a && pair.b ? "matched" : pair.a ? "a" : "b");
const TAG: Record<Exclude<Filter, "all">, string> = { matched: "matched", a: "only A", b: "only B" };

/** Two runs over the same audio side by side, so what a settings change did to speakers and claims is plain to see. */
export function CompareView({ a, b, titles }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [target, setTarget] = useState<Target | null>(null);

  const pairs = useMemo(() => matchClaims(a.claims.filter((c) => c.status === "ok"), b.claims.filter((c) => c.status === "ok")), [a.claims, b.claims]);
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { all: pairs.length, matched: 0, a: 0, b: 0 };
    for (const pair of pairs) out[kindOf(pair)]++;
    return out;
  }, [pairs]);
  const groups = useMemo(() => byMinute(filter === "all" ? pairs : pairs.filter((p) => kindOf(p) === filter)), [pairs, filter]);

  const labels = useMemo(() => ({ a: speakerLabeller(a.speakers), b: speakerLabeller(b.speakers) }), [a.speakers, b.speakers]);
  const runs = { a: a.runs, b: b.runs };
  const durationS = Math.max(a.endS, b.endS, 1);
  const changes = configDiff(a.session.config, b.session.config);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4">
      {!sameAudio(a.session, b.session) && <p className="text-bad">These sessions are not replays of the same audio; stream times may not line up.</p>}

      <section className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <SideHeader side="A" data={a} title={titles.a} />
          <SideHeader side="B" data={b} title={titles.b} />
        </div>
        <div className="rounded border border-line bg-panel px-3 py-2 text-sm">
          <h2 className="text-xs text-ink-faint">settings</h2>
          {changes.length === 0 ? (
            <p className="text-ink-dim">same settings</p>
          ) : (
            <ul>
              {changes.map((change) => (
                <li key={change.key} className="break-words">
                  <span className="text-ink-dim">{change.key}:</span> {formatSetting(change.a)} <span className="text-ink-faint">→</span>{" "}
                  <span className="text-accent">{formatSetting(change.b)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Speakers over time" className="space-y-3">
        <SpeakerStrip label={`A · ${titles.a}`} runs={runs.a} durationS={durationS} labelOf={labels.a} />
        <SpeakerStrip label={`B · ${titles.b}`} runs={runs.b} durationS={durationS} labelOf={labels.b} />
        <TimeAxis durationS={durationS} />
      </section>

      <section aria-label="Claims" className="space-y-3">
        <div role="group" aria-label="Show claims" className="flex flex-wrap gap-2 text-sm">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`rounded border px-2 py-0.5 ${filter === key ? "border-accent text-ink" : "border-line text-ink-dim hover:text-ink"} ${FOCUS}`}
            >
              {label} <span className="tabular-nums text-ink-faint">{counts[key]}</span>
            </button>
          ))}
        </div>
        {groups.length === 0 && <p className="text-ink-faint">no claims</p>}
        {groups.map((group) => (
          <div key={group.minute ?? "none"}>
            <h3 className="border-b border-line py-1 text-xs tabular-nums text-ink-faint">{group.minute === null ? "no time" : formatT(group.minute * 60)}</h3>
            <ol>
              {group.pairs.map((pair) => (
                <li key={`${pair.a?.id ?? "-"}:${pair.b?.id ?? "-"}`} className="grid gap-2 border-b border-line/50 py-2 sm:grid-cols-2">
                  <ClaimCell side="a" claim={pair.a} tag={TAG[kindOf(pair)]} labelOf={labels.a} onOpen={setTarget} />
                  <ClaimCell side="b" claim={pair.b} tag={TAG[kindOf(pair)]} labelOf={labels.b} onOpen={setTarget} />
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      <AuditDrawer
        target={target && { callId: target.callId, claimId: target.claimId }}
        speakers={(target?.side === "b" ? b : a).speakers}
        onClose={() => setTarget(null)}
      />
    </main>
  );
}

function byMinute(pairs: ClaimPair[]): { minute: number | null; pairs: ClaimPair[] }[] {
  // Pairs arrive in stream order with the timeless ones last, so a new group starts whenever the minute changes.
  const groups: { minute: number | null; pairs: ClaimPair[] }[] = [];
  for (const pair of pairs) {
    const t0 = pairT0(pair);
    const minute = t0 === null ? null : Math.floor(t0 / 60);
    const last = groups.at(-1);
    if (last && last.minute === minute) last.pairs.push(pair);
    else groups.push({ minute, pairs: [pair] });
  }
  return groups;
}

function SideHeader({ side, data, title }: { side: "A" | "B"; data: CompareSide; title: string }) {
  const { session, speakers, claims } = data;
  const live = speakers.filter((s) => s.merged_into === null);
  const facts = [
    new Date(session.created_at).toLocaleString(),
    session.status,
    Object.values(session.models).join(", "),
    `$${data.cost_usd.toFixed(2)}`,
  ].filter(Boolean);
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="text-accent">{side}</span>
        <Link href={`/session/${session.id}`} className={`min-w-0 break-words text-ink hover:text-accent ${FOCUS}`}>
          {title}
        </Link>
      </p>
      <p className="break-words text-xs text-ink-dim">{facts.join(" · ")}</p>
      <p className="text-xs text-ink-dim">
        {live.length} speakers · {live.filter((s) => s.name !== null).length} named · {claims.filter((c) => c.status === "ok").length} claims
      </p>
    </div>
  );
}

function ClaimCell({
  side,
  claim,
  tag,
  labelOf,
  onOpen,
}: {
  side: Side;
  claim: Claim | null;
  tag: string;
  labelOf: ReturnType<typeof speakerLabeller>;
  onOpen: (target: Target) => void;
}) {
  if (!claim) {
    return (
      <div className="px-2 py-1 text-xs text-ink-faint">
        {/* Stacked on a phone the dash needs its side to make sense. */}
        <span className="sm:hidden">{side.toUpperCase()} </span>
        <span aria-label={`not in ${side.toUpperCase()}`}>–</span>
      </div>
    );
  }
  const speaker = labelOf(claim.speaker_id);
  return (
    <button
      type="button"
      onClick={() => onOpen({ side, callId: claim.call_id, claimId: claim.id })}
      className={`min-w-0 rounded px-2 py-1 text-left hover:bg-panel ${FOCUS}`}
    >
      <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="text-accent">{side.toUpperCase()}</span>
        <span className="tabular-nums text-ink-faint">{claim.t0 === null ? "--:--" : formatT(claim.t0)}</span>
        <span className="text-ink-dim">{speaker.name ?? speaker.id ?? "unlabelled"}</span>
        <span className="ml-auto text-ink-faint">{tag}</span>
      </span>
      <span className="block break-words text-ink">{claim.claim}</span>
    </button>
  );
}
