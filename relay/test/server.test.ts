import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config";
import { createRelay } from "../src/server";
import { signTicket } from "../src/ticket";
import { fakeUpstream, frame, until, type FakeUpstream } from "./fake-upstream";

const SECRET = "relay-secret";
const ticket = (id = "s1", expS = Math.floor(Date.now() / 1000) + 3600) => signTicket(id, SECRET, expS);

interface Client {
  status: number;
  headers: Headers;
  text: () => string;
  close: () => void;
}

describe("relay server", () => {
  let up: FakeUpstream;
  let relay: Server;
  let base: string;
  const clients: Client[] = [];

  const start = async (overrides: Partial<Config> = {}) => {
    relay = createRelay({
      UPSTREAM_URL: up.url,
      API_SHARED_SECRET: "api-key",
      RELAY_SECRET: SECRET,
      ALLOWED_ORIGINS: ["https://app.example"],
      PORT: 0,
      RING_CAPACITY: 100,
      IDLE_CLOSE_MS: 60_000,
      MAX_VIEWERS: 100,
      KEEPALIVE_MS: 15_000,
      UPSTREAM_STALL_MS: 45_000,
      MAX_BUFFERED_BYTES: 128_000,
      FAILED_HOLD_MS: 60_000,
      ...overrides,
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  };

  const connect = async (query: string, headers: Record<string, string> = {}, id = "s1"): Promise<Client> => {
    const abort = new AbortController();
    const response = await fetch(`${base}/sessions/${id}/events?${query}`, { headers, signal: abort.signal });
    let text = "";
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch {
          // closed by the test
        }
      })();
    }
    const client = { status: response.status, headers: response.headers, text: () => text, close: () => abort.abort() };
    clients.push(client);
    return client;
  };
  const health = async () => (await fetch(`${base}/healthz`)).json();

  beforeEach(async () => {
    up = await fakeUpstream();
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    relay.closeAllConnections();
    await new Promise((r) => relay.close(r));
    await up.close();
  });

  it.each([
    ["no ticket", ""],
    ["a garbage ticket", "ticket=nope"],
    ["an expired ticket", `ticket=${ticket("s1", 1000)}`],
    ["another video's ticket", `ticket=${ticket("s2")}`],
  ])("refuses %s with 401 and never asks the api", async (_, query) => {
    await start();
    const client = await connect(`after=4&${query}`);
    expect(client.status).toBe(401);
    expect(up.requests).toHaveLength(0);
  });

  it("echoes an allowed origin and no other", async () => {
    await start();
    const allowed = await connect(`after=4&ticket=${ticket()}`, { origin: "https://app.example" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const other = await connect(`after=4&ticket=${ticket()}`, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves two viewers from one upstream request", async () => {
    await start();
    const a = await connect(`after=4&ticket=${ticket()}`);
    const b = await connect(`after=4&ticket=${ticket()}`);
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("text/event-stream");
    await until(() => up.open() === 1);
    up.send(5);
    await until(() => a.text().includes(frame(5)) && b.text().includes(frame(5)));
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0].headers.authorization).toBe("Bearer api-key");
  });

  it("gives a viewer the ring cannot serve its own passthrough, until it leaves", async () => {
    await start();
    await connect(`after=10&ticket=${ticket()}`);
    await until(() => up.open() === 1);
    const behind = await connect(`ticket=${ticket()}`, { "last-event-id": "1" });
    await until(() => up.open() === 2);
    expect(up.requests[1].after).toBe("1");
    up.send(11);
    await until(() => behind.text().includes(frame(11)));
    expect((await health()).passthroughs).toBe(1);
    behind.close();
    await until(() => up.open() === 1);
    await expect.poll(async () => (await health()).passthroughs).toBe(0);
  });

  it("after a restart, serves a reconnecting viewer from its Last-Event-ID", async () => {
    await start();
    const client = await connect(`ticket=${ticket()}`, { "last-event-id": "9" });
    await until(() => up.open() === 1);
    expect(up.requests[0].after).toBe("9");
    up.send(10);
    await until(() => client.text().includes(frame(10)));
  });

  it("refuses a viewer over MAX_VIEWERS with 503", async () => {
    await start({ MAX_VIEWERS: 2 });
    await connect(`after=4&ticket=${ticket()}`);
    await connect(`after=4&ticket=${ticket()}`);
    expect((await connect(`after=4&ticket=${ticket()}`)).status).toBe(503);
  });

  it("pings every open stream", async () => {
    await start({ KEEPALIVE_MS: 50 });
    const client = await connect(`after=4&ticket=${ticket()}`);
    await until(() => client.text().includes(": ping\n\n"));
  });

  it("counts viewers in /healthz and lets go of one that leaves", async () => {
    await start();
    const a = await connect(`after=4&ticket=${ticket()}`);
    await connect(`after=4&ticket=${ticket()}`);
    await until(() => up.open() === 1);
    const before = await health();
    expect(before.viewers).toBe(2);
    expect(before.channels).toEqual([expect.objectContaining({ sessionId: "s1", viewers: 2, state: "open", latest: 4 })]);
    a.close();
    await expect.poll(async () => (await health()).viewers).toBe(1);
  });

  it("refuses a reconnect to a video the api refused, so the browser falls back (review I-1)", async () => {
    up.status = 401;
    await start();
    const first = await connect(`after=4&ticket=${ticket()}`);
    expect(first.status).toBe(200);
    await expect.poll(async () => (await health()).channels.length).toBe(0);
    const again = await connect(`after=4&ticket=${ticket()}`);
    expect(again.status).toBe(502);
    expect(up.requests).toHaveLength(1);
  });

  it("drops a viewer that stops reading before it costs more than MAX_BUFFERED_BYTES (review I-3)", async () => {
    await start({ MAX_BUFFERED_BYTES: 64_000 });
    const { connect: rawConnect } = await import("node:net");
    const port = Number(new URL(base).port);
    const socket = rawConnect(port, "127.0.0.1");
    socket.write(`GET /sessions/s1/events?after=4&ticket=${ticket()} HTTP/1.1\r\nHost: x\r\n\r\n`);
    socket.pause();
    await until(() => up.open() === 1);
    for (let s = 5; s < 45; s++) up.send(s, "segment", 500_000);
    await expect.poll(async () => (await health()).viewers, { timeout: 5000 }).toBe(0);
    socket.destroy();
  });

  it("never writes its own pings into a passthrough, where they could split a frame (review I-5)", async () => {
    await start({ KEEPALIVE_MS: 20 });
    await connect(`after=10&ticket=${ticket()}`);
    await until(() => up.open() === 1);
    const behind = await connect(`ticket=${ticket()}`, { "last-event-id": "1" });
    await until(() => up.open() === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(behind.text()).not.toContain(": ping");
  });

  it("answers the CORS preflight a reconnect with Last-Event-ID may send (review I-6)", async () => {
    await start();
    const res = await fetch(`${base}/sessions/s1/events`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "GET", "access-control-request-headers": "last-event-id" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("last-event-id");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("answers 404 for any other path", async () => {
    await start();
    expect((await fetch(`${base}/sessions/s1`)).status).toBe(404);
  });
});
