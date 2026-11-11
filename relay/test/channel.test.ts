import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Channel } from "../src/channel";
import { parseFrames } from "../src/sse";
import { fakeUpstream, frame, until, type FakeUpstream } from "./fake-upstream";

describe("parseFrames", () => {
  it("yields whole frames across chunk boundaries and skips comments", () => {
    const parse = parseFrames();
    const whole = frame(5) + ": ping\n\n" + frame(6, "health");
    const out = [...parse(whole.slice(0, 17)), ...parse(whole.slice(17))];
    expect(out.map((e) => [e.seq, e.type])).toEqual([
      [5, "segment"],
      [6, "health"],
    ]);
    expect(out[0].raw).toBe(frame(5));
  });

  it("accepts CRLF line ends", () => {
    expect(parseFrames()(frame(7).replaceAll("\n", "\r\n")).map((e) => e.seq)).toEqual([7]);
  });
});

describe("Channel", () => {
  let up: FakeUpstream;
  let channel: Channel | null = null;
  let closed = 0;
  const open = (after: number, extra: Partial<ConstructorParameters<typeof Channel>[0]> = {}) => {
    channel = new Channel({
      sessionId: "s1",
      after,
      upstreamUrl: up.url,
      secret: "key",
      ringCapacity: 100,
      idleCloseMs: 60_000,
      minBackoffMs: 10,
      maxBackoffMs: 50,
      onClosed: () => closed++,
      ...extra,
    });
    return channel;
  };
  const viewer = () => {
    const got: string[] = [];
    let ended = false;
    return { got, write: (raw: string) => void got.push(raw), end: () => void (ended = true), ended: () => ended };
  };

  beforeEach(async () => {
    up = await fakeUpstream();
    closed = 0;
  });
  afterEach(async () => {
    channel?.close();
    channel = null;
    await up.close();
  });

  it("fans out once: one upstream request, every viewer gets each event once", async () => {
    const ch = open(4);
    const a = viewer();
    const b = viewer();
    expect(ch.join(4, a.write, a.end)).toBe("joined");
    expect(ch.join(4, b.write, b.end)).toBe("joined");
    await until(() => up.open() === 1);
    up.send(5);
    await until(() => a.got.length === 1 && b.got.length === 1);
    expect(a.got).toEqual([frame(5)]);
    expect(b.got).toEqual([frame(5)]);
    expect(up.requests).toHaveLength(1);
    expect(up.requests[0].path).toBe("/sessions/s1/events");
    expect(up.requests[0].after).toBe("4");
    expect(up.requests[0].headers.authorization).toBe("Bearer key");
    expect(up.requests[0].headers["ngrok-skip-browser-warning"]).toBe("1");
  });

  it("catches a late viewer up from the ring and skips what it already has", async () => {
    const ch = open(4);
    const a = viewer();
    ch.join(4, a.write, a.end);
    await until(() => up.open() === 1);
    [5, 6, 7].forEach((s) => up.send(s));
    await until(() => a.got.length === 3);
    const late = viewer();
    expect(ch.join(5, late.write, late.end)).toBe("joined");
    expect(late.got).toEqual([frame(6), frame(7)]);
    const ahead = viewer();
    ch.join(9, ahead.write, ahead.end);
    up.send(8);
    up.send(10);
    await until(() => late.got.length === 4 && ahead.got.length === 1);
    expect(ahead.got).toEqual([frame(10)]);
  });

  it("resumes after a drop from the last seq, with no duplicate", async () => {
    const ch = open(4);
    const a = viewer();
    ch.join(4, a.write, a.end);
    await until(() => up.open() === 1);
    up.send(5);
    up.send(7);
    await until(() => a.got.length === 2);
    up.drop();
    await until(() => up.requests.length === 2 && up.open() === 1);
    expect(up.requests[1].after).toBe("7");
    up.send(7);
    up.send(8);
    await until(() => a.got.length === 3);
    expect(a.got).toEqual([frame(5), frame(7), frame(8)]);
    expect(a.ended()).toBe(false);
  });

  it("resets on an upstream snapshot and forwards it to everyone", async () => {
    const ch = open(4);
    const a = viewer();
    ch.join(4, a.write, a.end);
    await until(() => up.open() === 1);
    up.send(30, "snapshot");
    await until(() => a.got.length === 1);
    expect(a.got).toEqual([frame(30, "snapshot")]);
    expect(ch.join(20, viewer().write, () => {})).toBe("out-of-ring");
    expect(ch.join(30, viewer().write, () => {})).toBe("joined");
  });

  it("refuses a position before its ring", async () => {
    const ch = open(10);
    expect(ch.join(3, viewer().write, () => {})).toBe("out-of-ring");
    expect(ch.viewers).toBe(0);
  });

  it.each([404, 401])("gives up on %i: ends its viewers and stops asking", async (status) => {
    up.status = status;
    const ch = open(4);
    const a = viewer();
    ch.join(4, a.write, a.end);
    await until(() => a.ended());
    expect(ch.state).toBe("failed");
    expect(closed).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(up.requests).toHaveLength(1);
  });

  it("retries a 502 instead of giving up", async () => {
    up.status = 502;
    const ch = open(4);
    ch.join(4, viewer().write, () => {});
    await until(() => up.requests.length >= 2);
    up.status = 200;
    await until(() => ch.state === "open");
  });

  it("closes its upstream a while after the last viewer leaves, unless one comes back", async () => {
    const ch = open(4, { idleCloseMs: 50 });
    const a = viewer();
    ch.join(4, a.write, a.end);
    await until(() => up.open() === 1);
    ch.leave(a.write);
    await new Promise((r) => setTimeout(r, 20));
    const b = viewer();
    ch.join(4, b.write, b.end);
    await new Promise((r) => setTimeout(r, 80));
    expect(closed).toBe(0);
    expect(up.open()).toBe(1);
    ch.leave(b.write);
    await until(() => closed === 1 && up.open() === 0);
  });
});
