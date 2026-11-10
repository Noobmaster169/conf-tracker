import { z } from "zod";

import type { LlmClient } from "../src/agents/llm-client";
import { SummaryBody, type Talk } from "../src/contracts";

/**
 * A stand-in for the model, for `pnpm simulate --scripted` on a machine with no model login. It answers each step
 * from answers written into the script file. Everything downstream of the answer is the real code: the quote check,
 * the tracker's hysteresis, the name judge, the storage. It proves the plumbing and fills the pages; it says nothing
 * about how good the prompts are.
 */
export const Scripted = z.object({
  track: z.array(z.object({ from: z.number(), title: z.string().nullable(), quote: z.string() })),
  names: z.array(z.object({ speaker_id: z.string(), name: z.string(), role: z.string().nullable(), confidence: z.number(), quote: z.string() })),
  claims: z.array(z.object({ claim: z.string(), kind: z.string(), importance: z.number(), topics: z.array(z.string()), polarity: z.string(), quote: z.string() })),
  summaries: z.record(z.string(), SummaryBody),
});
export type Scripted = z.infer<typeof Scripted>;

const section = (user: string, heading: string): string => user.slice(user.indexOf(heading) + heading.length);
const lastTime = (text: string): number => {
  const stamps = [...text.matchAll(/\[(\d+):(\d{2}) /g)];
  const last = stamps.at(-1);
  return last ? Number(last[1]) * 60 + Number(last[2]) : 0;
};

export function scriptedLlm(script: Scripted, schedule: Talk[]): LlmClient {
  const answer = (system: string, user: string): unknown => {
    if (system.includes("which session of the stage's schedule")) {
      const now = lastTime(section(user, "## transcript"));
      const step = [...script.track].reverse().find((s) => now >= s.from) ?? script.track[0]!;
      const talk = schedule.find((t) => t.title === step.title);
      return { state: talk ? "talk" : "break", talk_id: talk?.id ?? null, confidence: 0.92, quote: step.quote };
    }
    if (system.includes("say who a speaker is")) {
      const transcript = section(user, "## transcript");
      const unnamed = section(user, "## speakers").split("## transcript")[0]!;
      return { proposals: script.names.filter((n) => transcript.includes(n.quote) && unnamed.includes(`${n.speaker_id}: (unnamed)`)) };
    }
    if (system.includes("briefing")) {
      const title = Object.keys(script.summaries).find((t) => user.includes(`"${t}"`));
      if (!title) throw new Error("no scripted summary for this session");
      return script.summaries[title];
    }
    const fresh = section(user, "## new lines (extract from these)");
    return { claims: script.claims.filter((c) => fresh.includes(c.quote)) };
  };
  return {
    async complete(request) {
      return {
        text: JSON.stringify(answer(request.system, request.user)),
        model: "scripted", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, latencyMs: 1,
      };
    },
  };
}
