import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relayWatch, STALL_MS, streamUrl } from "./stream-source";

describe("streamUrl", () => {
  const relay = { url: "https://live.example", ticket: "2000.ab/c+" };

  it("points at the relay, ticket encoded, when there is one", () => {
    expect(streamUrl("s 1", 4, relay, "relay")).toBe("https://live.example/sessions/s%201/events?after=4&ticket=2000.ab%2Fc%2B");
  });

  it("points at the Vercel route for the fallback, or when there is no relay", () => {
    expect(streamUrl("s1", 4, relay, "vercel")).toBe("/api/sessions/s1/events?after=4");
    expect(streamUrl("s1", 4, null, "relay")).toBe("/api/sessions/s1/events?after=4");
  });
});

describe("relayWatch", () => {
  let fellBack = 0;
  const watch = () => relayWatch(() => fellBack++);

  beforeEach(() => {
    vi.useFakeTimers();
    fellBack = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("falls back when the relay has not opened within 10 s", () => {
    expect(STALL_MS).toBe(10_000);
    watch().started();
    vi.advanceTimersByTime(9_999);
    expect(fellBack).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fellBack).toBe(1);
  });

  it("stays when it opens in time", () => {
    const w = watch();
    w.started();
    vi.advanceTimersByTime(5_000);
    w.opened();
    vi.advanceTimersByTime(60_000);
    expect(fellBack).toBe(0);
  });

  it("falls back at once when the relay refuses (the source is CLOSED)", () => {
    const w = watch();
    w.started();
    w.errored(true);
    expect(fellBack).toBe(1);
  });

  it("falls back when an open relay drops and does not come back within 10 s", () => {
    const w = watch();
    w.started();
    w.opened();
    w.errored(false);
    vi.advanceTimersByTime(5_000);
    w.opened();
    vi.advanceTimersByTime(20_000);
    expect(fellBack).toBe(0);
    w.errored(false);
    vi.advanceTimersByTime(10_000);
    expect(fellBack).toBe(1);
  });

  it("falls back only once and goes quiet after stop", () => {
    const w = watch();
    w.started();
    w.errored(true);
    w.errored(true);
    vi.advanceTimersByTime(30_000);
    expect(fellBack).toBe(1);
    const other = watch();
    other.started();
    other.stop();
    vi.advanceTimersByTime(30_000);
    expect(fellBack).toBe(1);
  });
});
