import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A stand-in for the api's GET /sessions/:id/events that the test drives frame by frame. */
export interface FakeUpstream {
  url: string;
  requests: { path: string; after: string | null; headers: IncomingMessage["headers"] }[];
  /** The status the next requests get; 200 opens a stream. */
  status: number;
  /** Headers sent with a non-200 answer, e.g. ngrok's own error code. */
  errorHeaders: Record<string, string>;
  /** Whether a 200 stream starts with a comment; off, the stream is silent until send(). */
  greet: boolean;
  send(seq: number, type?: string, padBytes?: number): void;
  /** Cuts every open stream, as a dropped tunnel would. */
  drop(): void;
  open(): number;
  close(): Promise<void>;
}

export const frame = (seq: number, type = "segment", padBytes = 0) =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, data: padBytes ? { pad: "x".repeat(padBytes) } : {} })}\n\n`;

export async function fakeUpstream(): Promise<FakeUpstream> {
  const streams = new Set<ServerResponse>();
  const fake: FakeUpstream = {
    url: "",
    requests: [],
    status: 200,
    errorHeaders: {},
    greet: true,
    send(seq, type = "segment", padBytes = 0) {
      for (const res of streams) res.write(frame(seq, type, padBytes));
    },
    drop() {
      for (const res of streams) res.socket?.destroy();
      streams.clear();
    },
    open: () => streams.size,
    close: () =>
      new Promise((resolve) => {
        fake.drop();
        server.close(() => resolve());
      }),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    fake.requests.push({ path: url.pathname, after: url.searchParams.get("after"), headers: req.headers });
    if (fake.status !== 200) {
      res.writeHead(fake.status, { "content-type": "application/json", ...fake.errorHeaders }).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (fake.greet) res.write(": open\n\n");
    streams.add(res);
    res.on("close", () => streams.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

export const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};
