import type { LlmClient, LlmRequest, LlmResponse } from "../llm-client";

/** A string is the model's text; an Error is thrown, as the proxy client would; a function answers per request. */
export type Reply = string | Error | ((request: LlmRequest) => string);

export interface FakeLlm {
  client: LlmClient;
  /** Every request made, in order. */
  requests: LlmRequest[];
}

/** Answers from a queue of replies; the last one repeats, so one reply serves any number of calls. */
export function fakeLlm(replies: Reply | Reply[]): FakeLlm {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const requests: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(request): Promise<LlmResponse> {
      requests.push(request);
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      if (reply === undefined) throw new Error("fakeLlm has no reply");
      if (reply instanceof Error) throw reply;
      const text = typeof reply === "function" ? reply(request) : reply;
      return { text, model: `fake/${request.model}`, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 }, costUsd: 0.001, latencyMs: 5 };
    },
  };
  return { client, requests };
}
