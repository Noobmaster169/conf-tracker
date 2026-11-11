import type { Line } from "./lines";

export interface Window {
  context: Line[];
  fresh: Line[];
  t0: number;
  t1: number;
}

export interface WindowConfig {
  context_tail_s: number;
  extract_max_s: number;
}

/**
 * The lines since the cursor (fresh), preceded by the tail before them (context). The fresh part starts at the cursor
 * and spans at most extract_max_s (always at least one line), so an outage cannot grow one call without bound; what is
 * left is the next window's. Nothing is ever skipped.
 */
export function selectWindow(lines: Line[], cursorT: number, cfg: WindowConfig): Window | null {
  const fresh: Line[] = [];
  for (const line of lines) {
    if (line.t1 <= cursorT) continue;
    if (fresh.length > 0 && line.t1 - fresh[0]!.t0 > cfg.extract_max_s) break;
    fresh.push(line);
  }
  const start = fresh[0];
  if (!start) return null;
  const context = lines.filter((line) => line.t1 <= start.t0 && line.t1 > start.t0 - cfg.context_tail_s);
  const first = context[0] ?? start;
  return { context, fresh, t0: first.t0, t1: fresh.at(-1)!.t1 };
}

/** Stream seconds as mm:ss; minutes keep counting past an hour, since the model only needs an order. */
export function mmss(t: number): string {
  const whole = Math.floor(t);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** `[mm:ss S3]`, or `[mm:ss S3 Jane Doe]` once S3 has a name; the id stays so the model can tell two people of one name apart. */
export function renderLine(line: Line, names: ReadonlyMap<string, string> = NO_NAMES): string {
  const id = line.speaker_id ?? "--";
  const name = line.speaker_id === null ? undefined : names.get(line.speaker_id);
  return `[${mmss(line.t0)} ${name ? `${id} ${name}` : id}] ${line.text}`;
}

const NONE = "(none)";

/** The user message: the sections the prompt (agents/prompts/extract) names, in this order. `onStage` is the schedule's context, when the video has a stage. */
export function renderWindow(window: Window, prior: { claim: string }[], names: ReadonlyMap<string, string> = NO_NAMES, onStage: string | null = null): string {
  const already = prior.length > 0 ? prior.map((c) => `- ${c.claim}`).join("\n") : NONE;
  const context = window.context.length > 0 ? window.context.map((l) => renderLine(l, names)).join("\n") : NONE;
  const fresh = window.fresh.map((l) => renderLine(l, names)).join("\n");
  const stage = onStage ? `## on stage\n${onStage}\n\n` : "";
  return `${stage}## already extracted\n${already}\n\n## context (already handled, for reference only)\n${context}\n\n## new lines (extract from these)\n${fresh}`;
}
