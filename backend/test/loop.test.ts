import { expect, test } from "vitest";

import { createLoop } from "../src/ingest/loop";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("advance queues one run per boundary passed, in order, each up to its boundary", async () => {
  const seen: number[] = [];
  const loop = createLoop(async (upTo) => void seen.push(upTo), { intervalS: 30, finalRun: false });
  loop.advance(10);
  loop.advance(65);
  loop.advance(89.9);
  loop.advance(90);
  await loop.flush();
  expect(seen).toEqual([30, 60, 90]);
});

test("boundaries passed while a run is in flight all run afterwards; none is skipped", async () => {
  const seen: number[] = [];
  let release: () => void = () => {};
  const loop = createLoop(
    (upTo) => {
      seen.push(upTo);
      return upTo === 30 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    },
    { intervalS: 30, finalRun: false },
  );
  loop.advance(30);
  await settle();
  loop.advance(150);
  await settle();
  expect(seen).toEqual([30]);
  release();
  await loop.flush();
  expect(seen).toEqual([30, 60, 90, 120, 150]);
});

test("flush with finalRun runs once more over everything; without it, nothing new", async () => {
  const seen: string[] = [];
  const final = createLoop(async (upTo) => void seen.push(`final ${upTo}`), { intervalS: 30, finalRun: true });
  final.advance(40);
  await final.flush();
  const quiet = createLoop(async (upTo) => void seen.push(`quiet ${upTo}`), { intervalS: 30, finalRun: false });
  await quiet.flush();
  expect(seen).toEqual(["final 30", "final Infinity"]);
});

test("nothing runs after stop, including what was queued", async () => {
  const seen: number[] = [];
  let release: () => void = () => {};
  const loop = createLoop(
    (upTo) => {
      seen.push(upTo);
      return new Promise<void>((resolve) => (release = resolve));
    },
    { intervalS: 30, finalRun: true },
  );
  loop.advance(90);
  await settle();
  loop.stop();
  release();
  await loop.flush();
  loop.advance(200);
  await loop.tick();
  expect(seen).toEqual([30]);
});

test("a run that throws does not stop the queue", async () => {
  const seen: number[] = [];
  const loop = createLoop(
    async (upTo) => {
      seen.push(upTo);
      if (upTo === 30) throw new Error("boom");
    },
    { intervalS: 30, finalRun: false },
  );
  loop.advance(60);
  await loop.flush();
  expect(seen).toEqual([30, 60]);
});

test("cancelQueued drops the queued runs, lets the one in flight finish, and flush's final pass still runs", async () => {
  const seen: number[] = [];
  let release: () => void = () => {};
  const loop = createLoop(
    (upTo) => {
      seen.push(upTo);
      return upTo === 30 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    },
    { intervalS: 30, finalRun: true },
  );
  loop.advance(150);
  await settle();
  expect(seen).toEqual([30]);
  loop.cancelQueued();
  const flushed = loop.flush();
  release();
  await flushed;
  expect(seen).toEqual([30, Number.POSITIVE_INFINITY]);
});

test("with latestOnly, boundaries passed while a run is in flight collapse into one run up to the newest", async () => {
  const seen: number[] = [];
  let release: () => void = () => {};
  const loop = createLoop(
    (upTo) => {
      seen.push(upTo);
      return upTo === 30 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    },
    { intervalS: 30, finalRun: false, latestOnly: true },
  );
  loop.advance(30);
  await settle();
  loop.advance(150);
  await settle();
  release();
  await loop.flush();
  loop.advance(180);
  await loop.flush();
  expect(seen).toEqual([30, 150, 180]);
});

test("with latestOnly, a run queued after cancelQueued is not skipped for a newer one that was cancelled", async () => {
  const seen: number[] = [];
  let release: () => void = () => {};
  const loop = createLoop(
    (upTo) => {
      seen.push(upTo);
      return upTo === 30 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    },
    { intervalS: 30, finalRun: false, latestOnly: true },
  );
  loop.advance(30);
  await settle();
  loop.advance(150);
  loop.cancelQueued();
  const ran = loop.tick(100);
  release();
  await ran;
  expect(seen).toEqual([30, 100]);
});
