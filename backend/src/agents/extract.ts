import { z } from "zod";

import { type CallSummary, type Claim, Polarity } from "../contracts";
import type { Queryable } from "../db";
import { isDuplicate, locateQuote } from "../pipeline/evidence";
import { renderWindow, type Window } from "../pipeline/window";
import * as calls from "../repositories/calls";
import * as claims from "../repositories/claims";
import type { LlmClient } from "./llm-client";
import type { Prompt } from "./prompts/registry";
import { callStructured } from "./structured";

export const ExtractOutput = z.object({
  claims: z.array(z.object({ claim: z.string().min(1), topics: z.array(z.string()), polarity: Polarity, quote: z.string() })),
});
export type ExtractOutput = z.infer<typeof ExtractOutput>;

export interface ExtractDeps {
  db: Queryable;
  llm: LlmClient;
  sessionId: string;
  prompt: Prompt;
}

export interface ExtractResult {
  call: CallSummary;
  claims: Claim[];
}

/** The evidence check: the line the quote sits in decides speaker and time, and a prior claim decides duplicate. */
function toClaims(output: ExtractOutput, window: Window, prior: Claim[]): claims.NewClaim[] {
  const lines = [...window.context, ...window.fresh];
  return output.claims.map((item): claims.NewClaim => {
    const located = locateQuote(lines, item.quote);
    const duplicate = isDuplicate(item, prior);
    return {
      speakerId: duplicate ? null : (located?.speaker_id ?? null),
      t0: duplicate ? null : (located?.t0 ?? null),
      t1: duplicate ? null : (located?.t1 ?? null),
      claim: item.claim,
      topics: item.topics,
      polarity: item.polarity,
      quote: item.quote,
      quoteVerified: !duplicate && located !== null,
      status: duplicate ? "duplicate" : located ? "ok" : "unverified",
    };
  });
}

/** One extraction over a window. Every attempt is a row in llm_calls, ok or not; a model failure returns no claims and never throws. */
export async function runExtraction(deps: ExtractDeps, window: Window, prior: Claim[], names: ReadonlyMap<string, string> = new Map()): Promise<ExtractResult> {
  const { call, data } = await callStructured(deps, ExtractOutput, window, renderWindow(window, prior, names));
  if (!data) return { call: calls.toSummary(call, 0), claims: [] };
  const stored = await claims.insertMany(deps.db, deps.sessionId, call.id, toClaims(data, window, prior));
  return { call: calls.toSummary(call, stored.length), claims: stored };
}
