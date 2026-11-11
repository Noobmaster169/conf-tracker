import { afterEach, describe, expect, it, vi } from "vitest";

import { relayFor, relayTicket, TICKET_TTL_S } from "./relay-ticket";

describe("relayTicket", () => {
  it("matches the relay's fixed vector (relay/test/ticket.test.ts)", async () => {
    expect(await relayTicket("s1", "k", 2000)).toBe("2000.0e48aa316ff9903351919868e5d203decd684253acc7e60b771413851f0e69b5");
  });
});

describe("relayFor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is null unless both RELAY_URL and RELAY_SECRET are set", async () => {
    vi.stubEnv("RELAY_URL", "");
    vi.stubEnv("RELAY_SECRET", "k");
    expect(await relayFor("s1")).toBeNull();
    vi.stubEnv("RELAY_URL", "https://live.example");
    vi.stubEnv("RELAY_SECRET", "");
    expect(await relayFor("s1")).toBeNull();
  });

  it("gives the relay's URL without a trailing slash and a ticket good for 12 hours", async () => {
    vi.stubEnv("RELAY_URL", "https://live.example/");
    vi.stubEnv("RELAY_SECRET", "k");
    const now = Math.floor(Date.now() / 1000);
    const relay = await relayFor("s1");
    expect(relay?.url).toBe("https://live.example");
    const exp = Number(relay?.ticket.split(".")[0]);
    expect(TICKET_TTL_S).toBe(43200);
    expect(exp - now).toBeGreaterThanOrEqual(43200 - 1);
    expect(exp - now).toBeLessThanOrEqual(43200 + 1);
    expect(relay?.ticket).toBe(await relayTicket("s1", "k", exp));
  });
});
