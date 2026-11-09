import { expect, test } from "vitest";

import type { LiveEvent } from "../src/contracts";
import { createHub } from "../src/realtime/hub";

const health = (t: number) => ({
  type: "health" as const,
  data: { t, lag_s: 0, gpu_ms_asr: 0, gpu_ms_diar: 0, buffer_s: 0, received_at: "2026-09-23T00:00:00.000Z" },
});

test("publish numbers events per session and delivers to subscribers", () => {
  const hub = createHub(10);
  const seen: LiveEvent[] = [];
  const unsubscribe = hub.subscribe("a", (e) => seen.push(e));
  const first = hub.publish("a", health(1));
  hub.publish("b", health(9));
  const second = hub.publish("a", health(2));
  expect([first.seq, second.seq]).toEqual([1, 2]);
  expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  unsubscribe();
  hub.publish("a", health(3));
  expect(seen).toHaveLength(2);
  expect(hub.lastSeq("a")).toBe(3);
  expect(hub.lastSeq("b")).toBe(1);
});

test("since and latest read the ring", () => {
  const hub = createHub(10);
  hub.publish("a", health(1));
  hub.publish("a", health(2));
  expect(hub.since("a", 1)?.map((e) => e.seq)).toEqual([2]);
  expect(hub.latest("a", "health")?.data).toMatchObject({ t: 2 });
  expect(hub.latest("a", "segment")).toBeNull();
  expect(hub.since("unknown", 0)).toEqual([]);
});

test("a listener that throws does not stop the others", () => {
  const hub = createHub(10);
  const seen: number[] = [];
  hub.subscribe("a", () => {
    throw new Error("boom");
  });
  hub.subscribe("a", (e) => seen.push(e.seq));
  hub.publish("a", health(1));
  expect(seen).toEqual([1]);
});

test("reads of an unknown session allocate nothing", () => {
  const hub = createHub(10);
  expect(hub.since("ghost", 0)).toEqual([]);
  expect(hub.since("ghost", 3)).toBeNull();
  expect(hub.lastSeq("ghost")).toBe(0);
  expect(hub.latest("ghost", "health")).toBeNull();
  expect(hub.publish("ghost", health(1)).seq).toBe(1);
});
