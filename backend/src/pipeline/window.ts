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
 * The lines since the cursor (fresh), preceded by the tail before them (context). Windows split lines by their end
 * time: fresh is every line ending after the cursor and no later than extract_max_s past the earliest start among them
 * (or, when none does, the line ending first), and the window ends at the latest of their ends. Lines can overlap, so
 * one ending later is never cut off and one ending earlier never comes back: each line is fresh in exactly one window.
 */
export function selectWindow(lines: Line[], cursorT: number, cfg: WindowConfig): Window | null {
  const after = lines.filter((line) => line.t1 > cursorT);
  if (after.length === 0) return null;
  const start = Math.min(...after.map((line) => line.t0));
  let fresh = after.filter((line) => line.t1 <= start + cfg.extract_max_s);
  if (fresh.length === 0) {
    const soonest = Math.min(...after.map((line) => line.t1));
    fresh = after.filter((line) => line.t1 === soonest);
  }
  const context = lines.filter((line) => line.t1 <= start && line.t1 > start - cfg.context_tail_s);
  const t1 = Math.max(...fresh.map((line) => line.t1));
  return { context, fresh, t0: context[0]?.t0 ?? start, t1 };
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
