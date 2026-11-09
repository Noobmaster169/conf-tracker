import type { SpeakerRun } from "@/lib/compare";
import { formatT } from "@/lib/format";
import { speakerColor } from "@/lib/speaker-color";
import type { SpeakerLabel } from "@/lib/speaker-names";

type Props = { label: string; runs: SpeakerRun[]; durationS: number; labelOf: (id: string | null) => SpeakerLabel };

const pct = (t: number, durationS: number) => `${(t / durationS) * 100}%`;

/** Who spoke when across the whole stream, one bar per session so the two diarizations read against each other. */
export function SpeakerStrip({ label, runs, durationS, labelOf }: Props) {
  const legend = [...new Set(runs.map((run) => run.speaker))];
  const nameOf = (id: string | null) => {
    const l = labelOf(id);
    return l.name ?? l.id ?? "unlabelled";
  };
  return (
    <div className="space-y-1">
      <p className="truncate text-sm text-ink-dim">{label}</p>
      <div className="relative h-5 w-full overflow-hidden rounded bg-panel">
        {runs.map((run) => (
          <div
            key={`${run.t0}:${run.speaker}`}
            className="absolute inset-y-0"
            style={{
              left: pct(run.t0, durationS),
              // A one-word run still shows as a sliver.
              width: `max(${pct(run.t1 - run.t0, durationS)}, 0.15%)`,
              background: speakerColor(run.speaker),
            }}
            title={`${formatT(run.t0)}–${formatT(run.t1)} · ${nameOf(run.speaker)}`}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-dim">
        {legend.map((id) => (
          <li key={id ?? "none"} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: speakerColor(id) }} />
            {nameOf(id)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Minute marks under the strips: every 5 min, every minute on a short stream. */
export function TimeAxis({ durationS }: { durationS: number }) {
  const step = durationS < 600 ? 60 : 300;
  const ticks: number[] = [];
  for (let t = 0; t <= durationS; t += step) ticks.push(t);
  // At phone width a long stream's labels would collide; keep every other one there.
  const thin = ticks.length > 8;
  return (
    <div aria-hidden className="relative h-4 w-full text-[10px] tabular-nums text-ink-faint">
      {ticks.map((t, i) => (
        <span
          key={t}
          className={`absolute top-0 border-line ${thin && i % 2 === 1 ? "hidden sm:block" : ""} ${
            // A mark near the right end hangs left of its line so it never pushes the page wider.
            i > 0 && t / durationS > 0.9 ? "-translate-x-full border-r pr-0.5" : "border-l pl-0.5"
          }`}
          style={{ left: pct(t, durationS) }}
        >
          {formatT(t)}
        </span>
      ))}
    </div>
  );
}
