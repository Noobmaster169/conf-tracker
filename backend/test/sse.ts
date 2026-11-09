import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { LiveEvent } from "../src/contracts";

/** Opens the SSE route and returns the first `n` parsed events, then aborts. */
export async function readSse(server: Server, path: string, n: number, headers: Record<string, string> = {}): Promise<LiveEvent[]> {
  const { port } = server.address() as AddressInfo;
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: "Bearer test-key", ...headers },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`SSE ${path} answered ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: LiveEvent[] = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("");
      if (data) out.push(LiveEvent.parse(JSON.parse(data)));
    }
  }
  controller.abort();
  return out;
}
