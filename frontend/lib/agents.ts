import type { AgentStatus } from "./api/agent-schemas";

/** The colour of a status dot. Slow borrows the theme's amber; idle is the colour of a line. */
export function dotClass(status: AgentStatus): string {
  return { ok: "bg-ok", failed: "bg-live", slow: "bg-[var(--kind-opinion)]", idle: "bg-line" }[status];
}

/** The same four as text colours, for a line that says what went wrong. */
export function toneClass(status: AgentStatus): string {
  return { ok: "text-ink", failed: "text-live", slow: "text-[var(--kind-opinion)]", idle: "text-ink-soft" }[status];
}

/** How long ago, in the largest whole unit: "12 s ago", "4 min ago", "3 h ago", "2 d ago". */
export function agoText(iso: string | null, now: Date): string {
  const then = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(then)) return "has not run yet";
  const seconds = Math.floor((now.getTime() - then) / 1000);
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

const two = (n: number): string => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a call was made, in UTC: the time alone today, the day and the time otherwise. */
export function clockText(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
  const sameDay = at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth() && at.getUTCDate() === now.getUTCDate();
  return sameDay ? `${time}:${two(at.getUTCSeconds())}` : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${time}`;
}

/** A model call's duration: "9.2 s", "1 min 34 s". */
export function tookText(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** When an agent last asked the model. The Watcher looks every minute but asks the model only about trouble, so for it "never" is good news. */
export function lastRunText(agent: { internal: boolean; last_run_at: string | null }, now: Date): string {
  if (agent.last_run_at === null && agent.internal) return "nothing to look into yet";
  return agoText(agent.last_run_at, now);
}
