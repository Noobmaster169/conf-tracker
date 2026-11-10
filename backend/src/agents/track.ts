import { z } from "zod";

import type { CallSummary, Talk } from "../contracts";
import { locateQuote } from "../pipeline/evidence";
import type { Line } from "../pipeline/lines";
import type { Read } from "../pipeline/tracking";
import * as calls from "../repositories/calls";
import { callStructured, type StructuredDeps } from "./structured";

export const TrackOutput = z.object({
  state: z.enum(["talk", "break", "unknown"]),
  talk_id: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  quote: z.string(),
});
export type TrackOutput = z.infer<typeof TrackOutput>;

export interface TrackResult {
  call: CallSummary;
  /** Null when the model failed; the belief then stands. */
  read: Read | null;
  quote: string | null;
}

/** One read of the stage. The answer is checked before it is believed: a talk not on the schedule is unknown, and a quote not in the transcript dates nothing. */
export async function runTracking(deps: StructuredDeps, input: string, lines: Line[], schedule: Talk[]): Promise<TrackResult> {
  const window = { t0: lines[0]?.t0 ?? 0, t1: lines.at(-1)?.t1 ?? 0 };
  const { call, data } = await callStructured(deps, TrackOutput, window, input);
  if (!data) return { call: calls.toSummary(call, 0), read: null, quote: null };
  const onSchedule = data.state !== "talk" || schedule.some((talk) => talk.id === data.talk_id);
  const located = locateQuote(lines, data.quote);
  return {
    call: calls.toSummary(call, 0),
    read: { state: onSchedule ? data.state : "unknown", talkId: data.state === "talk" ? data.talk_id : null, confidence: data.confidence, quoteT0: located?.t0 ?? null, t: window.t1 },
    quote: located ? data.quote : null,
  };
}
