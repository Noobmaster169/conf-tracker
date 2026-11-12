import type { z } from "zod";

import type { LlmCall } from "../contracts";
import { atomic, type Queryable } from "../db";
import { childLogger } from "../lib/logger";
import * as calls from "../repositories/calls";
import { type LlmClient, type LlmResponse, toOutputSchema } from "./llm-client";
import type { Prompt } from "./prompts/registry";

const log = childLogger({ module: "structured" });

export interface StructuredDeps {
  db: Queryable;
  llm: LlmClient;
  sessionId: string;
  prompt: Prompt;
}

export interface StructuredResult<T> {
  /** The last attempt's row. */
  call: LlmCall;
  /** The parsed answer, or null when the call failed or never matched the schema. */
  data: T | null;
}

// The second attempt shows the model its mistake; a third would repeat the second.
const MAX_ATTEMPTS = 2;

/** Not JSON is an invalid answer, which is a stored outcome and not an exception. */
function parseAnswer(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const describe = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

/**
 * One model call against a schema, for any step. Every attempt is a row in llm_calls, ok or not; a model failure answers
 * data null and never throws. `store` writes what an answer yields in the same transaction as the answered call's row:
 * either both are stored or neither (and it throws), so a stored answer never lacks what it yielded.
 */
export async function callStructured<T>(
  deps: StructuredDeps,
  schema: z.ZodType<T>,
  window: { t0: number; t1: number; talkId?: number },
  input: string,
  store?: (tx: Queryable, call: LlmCall, data: T) => Promise<void>,
): Promise<StructuredResult<T>> {
  const { db, llm, sessionId, prompt } = deps;
  const outputSchema = toOutputSchema(schema);
  const system = prompt.text.replace("{{schema}}", JSON.stringify(outputSchema, null, 2));
  const base = { step: prompt.step, promptVersion: prompt.version, windowT0: window.t0, windowT1: window.t1, talkId: window.talkId ?? null };
  let user = input;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let response: LlmResponse;
    try {
      response = await llm.complete({ model: prompt.model, system, user, maxTokens: prompt.maxTokens, outputSchema });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ sessionId, step: prompt.step, attempt, err: message }, "model call failed");
      const call = await calls.insert(db, sessionId, {
        ...base, model: prompt.model, attempt, input: user, output: null, parsed: null,
        inputTokens: null, outputTokens: null, costUsd: null, latencyMs: Date.now() - started, error: message,
      });
      return { call, data: null };
    }
    const parsed = schema.safeParse(parseAnswer(response.text));
    const row: calls.NewCall = {
      ...base,
      model: response.model ?? prompt.model,
      attempt,
      input: user,
      output: response.text,
      parsed: parsed.success ? parsed.data : null,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.costUsd,
      latencyMs: response.latencyMs,
      error: parsed.success ? null : describe(parsed.error),
    };
    const call =
      parsed.success && store
        ? await atomic(db, async (tx) => {
            const answered = await calls.insert(tx, sessionId, row);
            await store(tx, answered, parsed.data);
            return answered;
          })
        : await calls.insert(db, sessionId, row);
    log.info({ sessionId, step: prompt.step, attempt, ok: parsed.success, latencyMs: response.latencyMs, costUsd: response.costUsd }, "model call");
    if (parsed.success) return { call, data: parsed.data };
    if (attempt >= MAX_ATTEMPTS) return { call, data: null };
    user = `${input}\n\n## your previous answer\n${response.text}\n\n## what was wrong with it\n${describe(parsed.error)}\n\nReturn only the corrected JSON object.`;
  }
}
