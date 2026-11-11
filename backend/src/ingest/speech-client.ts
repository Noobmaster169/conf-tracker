import WebSocket from "ws";

import { SpeechEvent, type StartMessage } from "../contracts";
import { UpstreamError } from "../lib/errors";
import { childLogger } from "../lib/logger";

const log = childLogger({ module: "speech-client" });

export interface SpeechHandlers {
  onEvent(event: SpeechEvent): Promise<void>;
  onClose(reason: string): Promise<void>;
}

export interface SpeechLink {
  close(): void;
}

/** Opens one session on the speech service. Resolves once the start message is on the wire. */
export type SpeechConnector = (start: StartMessage, handlers: SpeechHandlers) => Promise<SpeechLink>;

/** How long speech may take to answer the websocket handshake before the connect counts as failed (and is retried). */
const HANDSHAKE_TIMEOUT_MS = 30_000;

export function wsSpeechConnector(url: string, opts: { handshakeTimeoutMs?: number } = {}): SpeechConnector {
  return (start, handlers) =>
    new Promise((resolve, reject) => {
      // A speech that accepts the connection but never answers would otherwise hold the leg's open forever.
      const ws = new WebSocket(url, { handshakeTimeout: opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS });
      // Events are handled strictly in order: a segment must be stored before the health that follows it.
      let chain: Promise<void> = Promise.resolve();
      let opened = false;
      let closed = false;
      const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        chain = chain
          .then(() => handlers.onClose(reason))
          .catch((error: unknown) =>
            log.error({ err: error instanceof Error ? error.message : String(error), sessionId: start.session_id }, "close handler failed"),
          );
      };

      ws.once("open", () => {
        opened = true;
        ws.send(JSON.stringify(start));
        resolve({ close: () => ws.close() });
      });
      ws.on("error", (error) => {
        if (!opened) {
          reject(new UpstreamError(503, `speech unreachable at ${url}: ${error.message}`, { cause: error, retryable: true }));
          return;
        }
        finish(`error: ${error.message}`);
      });
      ws.on("message", (data) => {
        let json: unknown = null;
        try {
          json = JSON.parse(String(data));
        } catch (error) {
          log.warn({ err: String(error), sessionId: start.session_id }, "speech sent something that is not JSON");
          return;
        }
        const parsed = SpeechEvent.safeParse(json);
        if (!parsed.success) {
          log.warn({ sessionId: start.session_id, issue: parsed.error.issues[0]?.message }, "speech event outside the contract");
          return;
        }
        chain = chain
          .then(() => handlers.onEvent(parsed.data))
          .catch((error: unknown) =>
            log.error({ err: error instanceof Error ? error.message : String(error), sessionId: start.session_id }, "event handler failed"),
          );
      });
      ws.once("close", (code) => finish(`close ${code}`));
    });
}
