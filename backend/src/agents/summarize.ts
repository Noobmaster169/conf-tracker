import { type Stage, SummaryBody, type Talk, type TalkSummary } from "../contracts";
import type { Line } from "../pipeline/lines";
import { speakerList, stageLine } from "../pipeline/tracking";
import { renderLine } from "../pipeline/window";
import * as summaries from "../repositories/summaries";
import { callStructured, type StructuredDeps } from "./structured";

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

/** The user message: the sections agents/prompts/summarize names, in this order. */
export function renderSummaryInput({ stage, talk, lines, names }: SummarizeInput): string {
  const session = [`"${talk.title}" (${talk.kind})`, talk.description, `Speakers: ${speakerList(talk)}`].filter(Boolean).join("\n");
  return `## stage\n${stageLine(stage)}\n\n## session\n${session}\n\n## transcript\n${renderTranscript(lines, names)}`;
}

/** One summary of one talk, stored with the call that wrote it. Null when the model failed; the failure is the call's row. */
export async function runSummary(deps: StructuredDeps, input: SummarizeInput): Promise<TalkSummary | null> {
  const window = { t0: input.lines[0]?.t0 ?? 0, t1: input.lines.at(-1)?.t1 ?? 0 };
  const { call, data } = await callStructured(deps, SummaryBody, window, renderSummaryInput(input));
  if (!data) return null;
  return summaries.insert(deps.db, { talkId: input.talk.id, sessionId: deps.sessionId, callId: call.id, summary: data });
}
