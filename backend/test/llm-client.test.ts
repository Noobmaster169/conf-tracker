import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";
import { afterEach, expect, test } from "vitest";

import { proxyLlmClient, toOutputSchema } from "../src/agents/llm-client";
import { UpstreamError } from "../src/lib/errors";

interface Scripted {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A stand-in proxy: answers the scripted responses in order and records what it was sent. */
function proxy(script: Scripted[]): Promise<{ url: string; server: Server; received: unknown[] }> {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
      const next = script.shift() ?? { status: 500, body: { error: { message: "script exhausted" } } };
      res.writeHead(next.status, { "content-type": "application/json", ...next.headers });
      res.end(JSON.stringify(next.body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, received })));
}

const ok = (text: string): Scripted => ({
  status: 200,
  body: { id: "m", type: "message", role: "assistant", model: "claude-sonnet", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 7 } },
  headers: { "x-llm-proxy-cost-usd": "0.0042", "x-llm-proxy-model": "claudecli/sonnet" },
});
const noSleep = async () => undefined;
let running: Server | null = null;
afterEach(() => running?.close());

test("a call sends the Messages shape with the schema and reads text, usage and the cost header", async () => {
  const { url, server, received } = await proxy([ok('{"claims":[]}')]);
  running = server;
  const client = proxyLlmClient({ baseUrl: url, sleep: noSleep });
  const schema = { type: "object", properties: { claims: { type: "array" } } };
  const response = await client.complete({ model: "sonnet", system: "sys", user: "usr", outputSchema: schema });
  expect(response).toMatchObject({ text: '{"claims":[]}', model: "claudecli/sonnet", stopReason: "end_turn", usage: { inputTokens: 40, outputTokens: 7 }, costUsd: 0.0042 });
  expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  expect(received[0]).toMatchObject({
    path: "/v1/messages",
    headers: { "x-api-key": "yt-stream", "content-type": "application/json" },
    body: { model: "sonnet", system: "sys", messages: [{ role: "user", content: "usr" }], max_tokens: 8000, output_config: { format: { type: "json_schema", schema } } },
  });
});

test("a 503 is retried once, a 400 is not, and the proxy's retryable verdict is kept", async () => {
  const { url, server, received } = await proxy([
    { status: 503, body: { error: { message: "provider restarting", retryable: true } } },
    ok("second time lucky"),
    { status: 400, body: { error: { message: "bad request", retryable: false } } },
  ]);
  running = server;
  const client = proxyLlmClient({ baseUrl: url, sleep: noSleep });
  expect((await client.complete({ model: "sonnet", system: "s", user: "u" })).text).toBe("second time lucky");
  await expect(client.complete({ model: "sonnet", system: "s", user: "u" })).rejects.toMatchObject({ status: 400, retryable: false, message: expect.stringMatching(/bad request/) });
  expect(received).toHaveLength(3);
});

test("a 502 marked not retryable (the CLI is not logged in) is not retried", async () => {
  const { url, server, received } = await proxy([{ status: 502, body: { error: { message: "provider_not_logged_in", retryable: false } } }]);
  running = server;
  await expect(proxyLlmClient({ baseUrl: url, sleep: noSleep }).complete({ model: "sonnet", system: "s", user: "u" })).rejects.toBeInstanceOf(UpstreamError);
  expect(received).toHaveLength(1);
});

test("an unreachable proxy is a retryable 503 after one retry, and a non-Messages body is a 502", async () => {
  await expect(proxyLlmClient({ baseUrl: "http://127.0.0.1:1", sleep: noSleep }).complete({ model: "sonnet", system: "s", user: "u" })).rejects.toMatchObject({ status: 503, retryable: true });
  const { url, server } = await proxy([{ status: 200, body: { hello: "world" } }, { status: 200, body: { hello: "world" } }]);
  running = server;
  await expect(proxyLlmClient({ baseUrl: url, sleep: noSleep }).complete({ model: "sonnet", system: "s", user: "u" })).rejects.toMatchObject({ status: 502 });
});

test("toOutputSchema is plain JSON Schema without the dialect marker", () => {
  const schema = toOutputSchema(z.object({ claims: z.array(z.object({ claim: z.string() })) }));
  expect(schema).not.toHaveProperty("$schema");
  expect(schema).toMatchObject({ type: "object", properties: { claims: { type: "array" } }, required: ["claims"] });
});
