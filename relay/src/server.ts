import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Channel } from "./channel";
import type { Config } from "./config";
import { verifyTicket } from "./ticket";

/** A viewer this far behind is not reading: dropping it keeps one slow phone from growing the relay's memory. */
const MAX_BUFFERED_BYTES = 1_000_000;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export type Log = (fields: Record<string, unknown>) => void;

/**
 * The relay: GET /sessions/:id/events for viewers holding a ticket, and GET /healthz. Each video's viewers share
 * one Channel; a viewer whose position the channel's ring no longer covers gets a passthrough, its own upstream
 * connection, which is exactly what every viewer had before the relay.
 */
export function createRelay(config: Config, log: Log = () => {}): Server {
  const channels = new Map<string, Channel>();
  let passthroughs = 0;
  const viewerCount = () => passthroughs + [...channels.values()].reduce((n, c) => n + c.viewers, 0);

  const json = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

  const channelFor = (sessionId: string, after: number): Channel => {
    const existing = channels.get(sessionId);
    if (existing) return existing;
    const channel = new Channel({
      sessionId,
      after,
      upstreamUrl: config.UPSTREAM_URL,
      secret: config.API_SHARED_SECRET,
      ringCapacity: config.RING_CAPACITY,
      idleCloseMs: config.IDLE_CLOSE_MS,
      onClosed: () => {
        if (channels.get(sessionId) === channel) channels.delete(sessionId);
        log({ msg: "channel closed", sessionId, state: channel.state });
      },
    });
    channels.set(sessionId, channel);
    log({ msg: "channel opened", sessionId, after });
    return channel;
  };

  /** Opens the stream to the browser and keeps it alive; returns the writer and a hook for when it closes. */
  const openStream = (res: ServerResponse, onClose: () => void) => {
    res.writeHead(200, SSE_HEADERS);
    const write = (raw: string): void => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        res.destroy();
        return;
      }
      res.write(raw);
    };
    const keepalive = setInterval(() => write(": ping\n\n"), config.KEEPALIVE_MS);
    res.on("close", () => {
      clearInterval(keepalive);
      onClose();
    });
    write(": open\n\n");
    return write;
  };

  const passthrough = async (req: IncomingMessage, res: ServerResponse, sessionId: string, after: number | null) => {
    passthroughs++;
    let released = false;
    const release = () => {
      if (!released) passthroughs--;
      released = true;
    };
    const abort = new AbortController();
    res.on("close", () => {
      abort.abort();
      release();
    });
    const query = after === null ? "" : `?after=${after}`;
    let upstream: Response;
    try {
      upstream = await fetch(`${config.UPSTREAM_URL.replace(/\/+$/, "")}/sessions/${encodeURIComponent(sessionId)}/events${query}`, {
        headers: { authorization: `Bearer ${config.API_SHARED_SECRET}`, accept: "text/event-stream", "ngrok-skip-browser-warning": "1" },
        signal: abort.signal,
      });
    } catch {
      release();
      if (!res.headersSent) json(res, 502, { error: "The event stream is unavailable." });
      return;
    }
    if (!upstream.ok || !upstream.body) {
      release();
      await upstream.body?.cancel().catch(() => {});
      json(res, upstream.status === 404 ? 404 : 502, { error: `The event stream answered ${upstream.status}.` });
      return;
    }
    const write = openStream(res, release);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        write(decoder.decode(value, { stream: true }));
      }
    } catch {
      // the viewer left, or the upstream dropped; either way this stream is over
    }
    res.end();
  };

  const events = (req: IncomingMessage, res: ServerResponse, sessionId: string, url: URL) => {
    const origin = req.headers.origin;
    if (origin && config.ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    if (!verifyTicket(url.searchParams.get("ticket") ?? "", sessionId, config.RELAY_SECRET, Math.floor(Date.now() / 1000))) {
      json(res, 401, { error: "No valid ticket for this video." });
      return;
    }
    if (viewerCount() >= config.MAX_VIEWERS) {
      json(res, 503, { error: "The relay is full." });
      return;
    }
    const afterRaw = (req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("after");
    const after = afterRaw !== null && afterRaw !== undefined && /^\d+$/.test(afterRaw) ? Number(afterRaw) : null;
    if (after === null) {
      void passthrough(req, res, sessionId, null);
      return;
    }
    const channel = channelFor(sessionId, after);
    // Joined before the stream opens, so the ring's catch-up is written straight after the headers.
    let write: ((raw: string) => void) | null = null;
    const buffered: string[] = [];
    const sink = (raw: string) => (write ? write(raw) : void buffered.push(raw));
    if (channel.join(after, sink, () => res.end()) === "out-of-ring") {
      void passthrough(req, res, sessionId, after);
      return;
    }
    write = openStream(res, () => channel.leave(sink));
    buffered.splice(0).forEach(write);
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, {
        ok: true,
        viewers: viewerCount(),
        passthroughs,
        channels: [...channels].map(([sessionId, c]) => ({ sessionId, viewers: c.viewers, state: c.state, latest: c.latest })),
      });
      return;
    }
    const match = /^\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(match[1]);
      } catch {
        json(res, 400, { error: "Bad session id." });
        return;
      }
      events(req, res, sessionId, url);
      return;
    }
    json(res, 404, { error: "Not found." });
  });
}
