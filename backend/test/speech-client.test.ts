import { createServer, type Server, type Socket } from "node:net";
import { afterAll, expect, test } from "vitest";

import { wsSpeechConnector } from "../src/ingest/speech-client";
import { UpstreamError } from "../src/lib/errors";

const sockets: Socket[] = [];
let server: Server | null = null;
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

test("a speech that accepts the connection but never answers the handshake is a connect failure, retried", async () => {
  // Accepts and then says nothing: without a handshake timeout the connect would hang for good.
  server = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const connect = wsSpeechConnector(`ws://127.0.0.1:${port}/sessions`, { handshakeTimeoutMs: 100 });
  const attempt = connect({ session_id: "s", config: {} }, { onEvent: async () => {}, onClose: async () => {} });
  const error = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UpstreamError);
  expect((error as UpstreamError).retryable).toBe(true);
}, 5000);
