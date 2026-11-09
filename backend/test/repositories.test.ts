import { afterAll, expect, test } from "vitest";

import { closePool } from "../src/db";
import * as events from "../src/repositories/events";
import * as segments from "../src/repositories/segments";
import * as sessions from "../src/repositories/sessions";
import { inRollback } from "./db";

afterAll(closePool);

const URL = "https://www.youtube.com/watch?v=QB5BNdBFujE";

test("a session is created starting, with its video id derived", async () => {
  await inRollback(async (tx) => {
    const session = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: { speed: 1 } });
    expect(session.status).toBe("starting");
    expect(session.video_id).toBe("QB5BNdBFujE");
    expect(session.config).toEqual({ speed: 1 });
    expect(await sessions.get(tx, session.id)).toEqual(session);
    expect((await sessions.list(tx)).map((s) => s.id)).toContain(session.id);
  });
});

test("get answers null for an unknown or malformed id", async () => {
  await inRollback(async (tx) => {
    expect(await sessions.get(tx, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await sessions.get(tx, "not-a-uuid")).toBeNull();
  });
});

test("markStarted and setStatus move the session through its life", async () => {
  await inRollback(async (tx) => {
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const live = await sessions.markStarted(tx, created.id, { startedAt: "2026-09-23T10:00:00.000Z", models: { asr: "large-v3" } });
    expect(live.status).toBe("live");
    expect(live.started_at).toBe("2026-09-23T10:00:00.000Z");
    expect(live.models).toEqual({ asr: "large-v3" });
    const stopped = await sessions.setStatus(tx, created.id, "stopped");
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopped_at).not.toBeNull();
    const again = await sessions.setStatus(tx, created.id, "stopped");
    expect(again.stopped_at).toBe(stopped.stopped_at);
  });
});

test("markStarted and setStatus reject an unknown id", async () => {
  await inRollback(async (tx) => {
    const nil = "00000000-0000-0000-0000-000000000000";
    await expect(sessions.markStarted(tx, nil, { startedAt: "2026-09-23T10:00:00.000Z", models: {} })).rejects.toThrow(/not found/);
    await expect(sessions.setStatus(tx, nil, "stopped")).rejects.toThrow(/not found/);
  });
});

test("markOrphansDegraded degrades starting and live sessions and leaves stopped ones", async () => {
  await inRollback(async (tx) => {
    const starting = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const live = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.markStarted(tx, live.id, { startedAt: "2026-09-23T10:00:00.000Z", models: {} });
    const stopped = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await sessions.setStatus(tx, stopped.id, "stopped");
    // Other suites commit rows to this database, so the returned list is checked by id, never by length.
    const ids = (await sessions.markOrphansDegraded(tx)).map((s) => s.id);
    expect(ids).toContain(starting.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(stopped.id);
    expect((await sessions.get(tx, starting.id))?.status).toBe("degraded");
    expect((await sessions.get(tx, stopped.id))?.status).toBe("stopped");
  });
});

test("setError stops the session, keeps the message and rejects an unknown id", async () => {
  await inRollback(async (tx) => {
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    expect(created.error).toBeNull();
    const failed = await sessions.setError(tx, created.id, "yt-dlp failed");
    expect(failed.status).toBe("stopped");
    expect(failed.error).toBe("yt-dlp failed");
    expect(failed.stopped_at).not.toBeNull();
    await expect(sessions.setError(tx, "00000000-0000-0000-0000-000000000000", "x")).rejects.toThrow(/not found/);
  });
});

test("segments insert and list by time range, latest ascending", async () => {
  await inRollback(async (tx) => {
    const session = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    for (const t0 of [0, 5, 10, 15]) {
      await segments.insert(tx, session.id, { t0, t1: t0 + 4, text: `at ${t0}`, words: [{ w: "at", t0, t1: t0 + 1, p: 0.9, speaker_id: null }] });
    }
    expect((await segments.list(tx, session.id, { from: 4, to: 11 })).map((s) => s.t0)).toEqual([5, 10]);
    expect((await segments.latest(tx, session.id, 2)).map((s) => s.t0)).toEqual([10, 15]);
    const [first] = await segments.list(tx, session.id, { limit: 1 });
    expect(first?.words[0]?.speaker_id).toBeNull();
  });
});

test("events append in order and refuse a repeated seq", async () => {
  await inRollback(async (tx) => {
    const session = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await events.append(tx, session.id, 1, "health", { t: 1 });
    await events.append(tx, session.id, 2, "health", { t: 2 });
    expect((await events.list(tx, session.id)).map((e) => e.seq)).toEqual([1, 2]);
    await expect(events.append(tx, session.id, 2, "health", { t: 3 })).rejects.toThrow(/duplicate key/);
  });
});

test("maxSeq is 0 for a fresh session and the highest stored seq after appends", async () => {
  await inRollback(async (tx) => {
    const session = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    expect(await events.maxSeq(tx, session.id)).toBe(0);
    await events.append(tx, session.id, 1, "health", { t: 1 });
    await events.append(tx, session.id, 2, "health", { t: 2 });
    expect(await events.maxSeq(tx, session.id)).toBe(2);
  });
});
