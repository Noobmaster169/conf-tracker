import type { Stage, Talk, TalkSummary } from "../contracts";
import { childLogger } from "../lib/logger";
import type { Line } from "../pipeline/lines";
import { speakerList, stageLine } from "../pipeline/tracking";
import { renderLine } from "../pipeline/window";
import * as calls from "../repositories/calls";
import * as summaries from "../repositories/summaries";
import type { StructuredDeps } from "./structured";

const log = childLogger({ module: "summarize" });

// About 40k tokens: more than an hour of speech. A longer talk keeps its start and its end, where the framing and the conclusions are.
const MAX_CHARS = 160_000;
const HEAD_SHARE = 0.6;

/** The transcript as text, cut in the middle when it would not fit, with the cut marked. */
export function renderTranscript(lines: Line[], names: ReadonlyMap<string, string>, maxChars = MAX_CHARS): string {
  const rendered = lines.map((l) => renderLine(l, names));
  const total = rendered.reduce((n, line) => n + line.length + 1, 0);
  if (total <= maxChars) return rendered.join("\n");
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  for (const line of rendered) {
    if (used + line.length > maxChars * HEAD_SHARE) break;
    head.push(line);
    used += line.length + 1;
  }
  used = 0;
  for (const line of rendered.slice(head.length).reverse()) {
    if (used + line.length > maxChars * (1 - HEAD_SHARE)) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  return [...head, "[... the middle of the session is left out for length ...]", ...tail].join("\n");
}

export interface SummarizeInput {
  stage: Stage;
  talk: Talk;
  lines: Line[];
  names: ReadonlyMap<string, string>;
}

/** How long the article should be for a session of this length: yt-engine's getWordCountRange, unchanged. */
export function wordCountRange(minutes: number): { min: number; max: number } {
  if (minutes < 15) return { min: 400, max: 800 };
  if (minutes <= 45) return { min: 800, max: 1500 };
  return { min: 1200, max: 2000 };
}

/** The time the talk was actually on stage: the sum of its lines' spans, so a break in the middle does not count. */
export function heardMinutes(lines: Line[]): number {
  return lines.reduce((s, line) => s + Math.max(0, line.t1 - line.t0), 0) / 60;
}

/** The user message: a header about the session, then the transcript, as yt-engine's buildUserMessage lays it out. */
export function renderSummaryInput({ stage, talk, lines, names }: SummarizeInput): string {
  const header = [
    `Conference: ${stageLine(stage)}`,
    `Session: "${talk.title}" (${talk.kind})`,
    talk.description ? `About: ${talk.description}` : null,
    `Speakers: ${speakerList(talk)}`,
    `Duration: ~${Math.max(1, Math.round(heardMinutes(lines)))} minutes`,
  ].filter(Boolean);
  return `${header.join("\n")}\n\nTranscript:\n${renderTranscript(lines, names)}`;
}

/** The article's headline: its first `#` heading, or failing that its first line, without the markdown around it. */
export function headlineOf(article: string): string {
  const lines = article.split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#\s+/.test(line)) ?? lines[0] ?? "";
  return heading.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
}

/**
 * One summary of one talk: a markdown article written with yt-engine's summary prompt (prompts/summarize), stored with
 * the call that wrote it. Every attempt is a row in llm_calls. Null when the model failed or wrote nothing; the reason
 * is on the call's row.
 */
export async function runSummary(deps: StructuredDeps, input: SummarizeInput): Promise<TalkSummary | null> {
  const { db, llm, sessionId, prompt } = deps;
  const range = wordCountRange(heardMinutes(input.lines));
  const system = prompt.text.replace("{{word_min}}", String(range.min)).replace("{{word_max}}", String(range.max));
  const user = renderSummaryInput(input);
  const base = {
    step: prompt.step, promptVersion: prompt.version, windowT0: input.lines[0]?.t0 ?? 0, windowT1: input.lines.at(-1)?.t1 ?? 0, attempt: 1, input: user,
  };
  const started = Date.now();
  try {
    const response = await llm.complete({ model: prompt.model, system, user, maxTokens: prompt.maxTokens });
    const content = response.text.trim();
    const headline = headlineOf(content);
    const call = await calls.insert(db, sessionId, {
      ...base, model: response.model ?? prompt.model, output: response.text, parsed: headline ? { headline } : null,
      inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd: response.costUsd, latencyMs: response.latencyMs,
      error: headline ? null : "the model wrote no article",
    });
    if (!headline) return null;
    return await summaries.insert(db, { talkId: input.talk.id, sessionId, callId: call.id, summary: { headline, content } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ sessionId, talkId: input.talk.id, err: message }, "summary call failed");
    await calls.insert(db, sessionId, {
      ...base, model: prompt.model, output: null, parsed: null, inputTokens: null, outputTokens: null, costUsd: null, latencyMs: Date.now() - started, error: message,
    });
    return null;
  }
}

