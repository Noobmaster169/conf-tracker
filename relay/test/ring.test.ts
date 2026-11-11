import { describe, expect, it } from "vitest";

import { Ring, type RelayEvent } from "../src/ring";

const ev = (seq: number): RelayEvent => ({ seq, type: "segment", raw: `id: ${seq}\n\n` });
const seqs = (events: RelayEvent[] | null) => events?.map((e) => e.seq) ?? null;

describe("ring", () => {
  it("serves what follows a position it covers", () => {
    const ring = new Ring(3, 10);
    [11, 12, 13].forEach((s) => ring.push(ev(s)));
    expect(seqs(ring.since(10))).toEqual([11, 12, 13]);
    expect(seqs(ring.since(12))).toEqual([13]);
    expect(seqs(ring.since(13))).toEqual([]);
    expect(seqs(ring.since(50))).toEqual([]);
    expect(ring.latest).toBe(13);
  });

  it("moves its base when it evicts, and refuses a position before it", () => {
    const ring = new Ring(3, 10);
    [11, 12, 13, 14].forEach((s) => ring.push(ev(s)));
    expect(ring.base).toBe(11);
    expect(ring.since(10)).toBeNull();
    expect(seqs(ring.since(11))).toEqual([12, 13, 14]);
  });

  it("starts over from a new base on reset", () => {
    const ring = new Ring(3, 10);
    [11, 12].forEach((s) => ring.push(ev(s)));
    ring.reset(40);
    expect(ring.since(39)).toBeNull();
    expect(seqs(ring.since(40))).toEqual([]);
    expect(ring.latest).toBe(40);
  });
});
