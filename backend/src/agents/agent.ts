import type { z } from "zod";

/** What one call caused, read from the rows that point back at it. */
export interface CallEffects {
  /** Rows in claims with this call_id. */
  claims: number;
  /** The name proposals of this call that were accepted. */
  named: { voice: string; name: string }[];
  /** The title of the talk whose stretch of the timeline this call opened; null when it opened none. */
  switchedTo: string | null;
  /** The title of the talk whose summary this call wrote. */
  summaryOf: string | null;
}

export const NO_EFFECTS: CallEffects = { claims: 0, named: [], switchedTo: null, summaryOf: null };

/**
 * The standard every agent conforms to. A definition describes an agent; it does not run it. Whatever is listed in
 * registry.ts gets its card and page in Admin, its calls, its activity, settings editing and the Watcher's coverage.
 * Adding one: README.md in this directory.
 */
export interface AgentDefinition {
  /** Equals llm_calls.step and the prompt directory. Never changes once calls exist. */
  id: string;
  /** What people call it. */
  name: string;
  /** One line, plain words. */
  role: string;
  /** When it runs, as a sentence, and the setting that holds its interval if it has one. */
  trigger: { text: string; intervalKey?: string };
  /** What it is given and what it writes, as short labels. */
  reads: string[];
  writes: string[];
  /** Its settings; null for an agent with none. */
  settings: z.ZodObject | null;
  /** Where its settings live: in each video's config, or once for the whole app. */
  settingsScope: "video" | "global";
  /** Which settings name its instructions version and its model. */
  promptKey?: string;
  modelKey?: string;
  /** Settings a running video only reads when it starts. */
  fixedAtStart: string[];
  /** The shape of its answer; null for one that answers in free text. */
  output: z.ZodType | null;
  /** True for an agent whose calls are about the app, not the video's content: left out of a video's public call feed. */
  internal: boolean;
  /** One line for a call in a list. */
  describe(call: { error: string | null; parsed: unknown }, effects: CallEffects): string;
}

const LINE = 80;
export const clip = (text: string, max = LINE): string => (text.length > max ? text.slice(0, max) : text);

/** The line every agent gives a failed call; null when the call did not fail. */
export const failedLine = (call: { error: string | null }): string | null => (call.error === null ? null : `Failed: ${clip(call.error)}`);

/** A field of a stored answer, when the answer is an object that has it as text. */
export function field(parsed: unknown, key: string): string | null {
  const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : null;
}
