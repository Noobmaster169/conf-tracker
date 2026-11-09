import { z } from "zod";

import { config } from "../config";
import { isTransient, RetryableError, UpstreamError } from "../lib/errors";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "llm-client" });

// Not a credential: the proxy reads it as the project the call is attributed to.
const PROJECT = "yt-stream";
// The wire requires a cap; this is generous, not a budget. `claude -p` ignores it.
const DEFAULT_MAX_TOKENS = 8000;
const REQUEST_TIMEOUT_MS = 300_000;
const RETRY_DELAY_MS = 2000;

export interface LlmRequest {
  /** A proxy alias from proxy/proxy.yaml (sonnet, opus, haiku, test), never a provider model id. */
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  /** JSON Schema the answer must match, enforced by the provider: with it the text that comes back is that object. */
  outputSchema?: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  /** What the proxy resolved the alias to, when it says. */
  model: string | null;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number | null;
  latencyMs: number;
}

/** Every model call goes through this. Tests hand in fakeLlm; nothing in a test reaches the proxy. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

const MessageBody = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  model: z.string().nullish(),
  stop_reason: z.string().nullish(),
  usage: z.object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) }),
});

const ErrorBody = z.object({ error: z.object({ message: z.string().optional(), retryable: z.boolean().optional() }).optional() });

/** The schema as the provider takes it: plain JSON Schema, without the dialect marker some reject. */
export function toOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema);
  return rest;
}

export interface ProxyClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function proxyLlmClient(options: ProxyClientOptions = {}): LlmClient {
  const baseUrl = (options.baseUrl ?? config.LLM_PROXY_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function once(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const body = {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      ...(request.outputSchema ? { output_config: { format: { type: "json_schema", schema: request.outputSchema } } } : {}),
    };
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": PROJECT, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RetryableError(`llm-proxy gave no answer within ${timeoutMs / 1000} s`, { cause: error });
      }
      throw new UpstreamError(503, `llm-proxy unreachable at ${baseUrl}`, { cause: error, retryable: true });
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(json);
      const message = parsed.success ? parsed.data.error?.message : undefined;
      throw new UpstreamError(response.status, `llm-proxy returned ${response.status}: ${message ?? "no message"}`, {
        retryable: parsed.success ? (parsed.data.error?.retryable ?? null) : null,
      });
    }
    const parsed = MessageBody.safeParse(json);
    if (!parsed.success) throw new UpstreamError(502, "llm-proxy answered outside the Messages shape", { retryable: false });
    const costHeader = response.headers.get("x-llm-proxy-cost-usd");
    const cost = Number(costHeader);
    return {
      text: parsed.data.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").trim(),
      model: response.headers.get("x-llm-proxy-model") ?? parsed.data.model ?? null,
      stopReason: parsed.data.stop_reason ?? null,
      usage: { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens },
      costUsd: costHeader !== null && Number.isFinite(cost) ? cost : null,
      latencyMs: Date.now() - started,
    };
  }

  return {
    async complete(request) {
      try {
        return await once(request);
      } catch (error) {
        // One retry for what the proxy itself calls transient; a typo'd alias or a missing login fails the same way every time.
        const transient = error instanceof RetryableError || (error instanceof UpstreamError && isTransient(error));
        if (!transient) throw error;
        log.warn({ model: request.model, err: error instanceof Error ? error.message : String(error) }, "transient model failure, retrying once");
        await sleep(retryDelayMs);
        return once(request);
      }
    },
  };
}
