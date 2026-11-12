import type { RunStatus } from "@/lib/api-client";

const SLOTS = 24;
const BAR: Record<RunStatus, string> = { ok: "bg-ok opacity-50", failed: "bg-live", slow: "bg-[var(--kind-opinion)]" };

/** An agent's last runs as a row of bars, newest on the right: trouble is seen before anything is read. */
export function RunStrip({ recent }: { recent: RunStatus[] }) {
  const empty = Math.max(0, SLOTS - recent.length);
  const failed = recent.filter((s) => s === "failed").length;
  const slow = recent.filter((s) => s === "slow").length;
  const label = recent.length === 0 ? "No runs yet" : `Last ${recent.length} runs: ${failed} failed, ${slow} slow`;
  return (
    <span role="img" aria-label={label} title={label} className="flex shrink-0 items-end gap-[3px]">
      {Array.from({ length: empty }, (_, i) => (
        <i key={`e${i}`} className="h-5 w-[5px] rounded-sm bg-line opacity-60" />
      ))}
      {recent.map((status, i) => (
        <i key={i} className={`h-5 w-[5px] rounded-sm ${BAR[status]}`} />
      ))}
    </span>
  );
}
