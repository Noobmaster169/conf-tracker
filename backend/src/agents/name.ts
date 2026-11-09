import { z } from "zod";

import type { CallSummary, NameProposal, Speaker } from "../contracts";
import { judgeProposals, type NameWindow, renderNameWindow } from "../pipeline/naming";
import * as calls from "../repositories/calls";
import * as names from "../repositories/names";
import * as speakers from "../repositories/speakers";
import { callStructured, type StructuredDeps } from "./structured";

export const NameOutput = z.object({
  proposals: z.array(
    z.object({ speaker_id: z.string().min(1), name: z.string().min(1), role: z.string().nullable(), confidence: z.number().min(0).max(1), quote: z.string() }),
  ),
});
export type NameOutput = z.infer<typeof NameOutput>;

const LOST_RACE = "speaker merged or named more confidently during the call";

export interface NameDeps extends StructuredDeps {
  floor: number;
}

export interface NameResult {
  call: CallSummary;
  proposals: NameProposal[];
  /** Each speaker whose name changed, once, as last written. */
  named: Speaker[];
}

/** One naming call over a window. Every proposal is stored with the judge's verdict; only accepted ones touch a speaker. Never throws for a model failure. */
export async function runNaming(deps: NameDeps, window: NameWindow, roster: Speaker[]): Promise<NameResult> {
  const { db, sessionId } = deps;
  const { call, data } = await callStructured(deps, NameOutput, window, renderNameWindow(window, roster));
  if (!data) return { call: calls.toSummary(call, 0), proposals: [], named: [] };
  // Names are written before the proposals are stored: a stored row is never updated, so its verdict must already
  // account for a merge or a stronger name that landed while the model was answering.
  const named = new Map<string, Speaker>();
  const verdicts = [];
  for (const p of judgeProposals(data.proposals, window, roster, deps.floor)) {
    if (p.status !== "accepted") { verdicts.push(p); continue; }
    const speaker = await speakers.setName(db, sessionId, p.speakerId, { name: p.name, role: p.role, confidence: p.confidence, quote: p.quote, callId: call.id });
    if (speaker) named.set(speaker.speaker_id, speaker);
    verdicts.push(speaker ? p : { ...p, status: "rejected" as const, reason: LOST_RACE });
  }
  const proposals = await names.insertMany(db, sessionId, call.id, verdicts);
  return { call: calls.toSummary(call, 0), proposals, named: [...named.values()] };
}
