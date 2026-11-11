import { afterAll, expect, test } from "vitest";

import { closePool } from "../src/db";
import * as events from "../src/repositories/events";
import * as gaps from "../src/repositories/gaps";
import * as legs from "../src/repositories/legs";
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

test("a recovering session round-trips, keeps its first recovering_since, and markStarted clears it and the attention note", async () => {
  await inRollback(async (tx) => {
    const created = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    expect(created.attention).toBeNull();
    expect(created.recovering_since).toBeNull();
    const first = await sessions.setRecovering(tx, created.id);
    expect(first.status).toBe("recovering");
    expect(first.recovering_since).not.toBeNull();
    expect(await sessions.get(tx, created.id)).toEqual(first);
    await tx.query("select pg_sleep(0.01)");
    const second = await sessions.setRecovering(tx, created.id);
    expect(second.recovering_since).toBe(first.recovering_since);
    expect((await sessions.setAttention(tx, created.id, "stuck")).attention).toBe("stuck");
    expect((await sessions.running(tx)).map((s) => s.id)).toContain(created.id);
    const live = await sessions.markStarted(tx, created.id, { startedAt: "2026-11-12T10:00:00.000Z", models: {} });
    expect(live.attention).toBeNull();
    expect(live.recovering_since).toBeNull();
    expect((await sessions.setAttention(tx, created.id, null)).attention).toBeNull();
    await sessions.setStatus(tx, created.id, "stopped");
    expect((await sessions.running(tx)).map((s) => s.id)).not.toContain(created.id);
  });
});

test("legs open, start, end and answer the latest; gaps list only unfilled ones in order; remove takes both", async () => {
  await inRollback(async (tx) => {
    const s = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    expect(await legs.latest(tx, s.id)).toBeNull();
    const a = await legs.open(tx, s.id, { speechId: "x-1", kind: "main", requestedT: 0 });
    expect(a).toMatchObject({ session_id: s.id, speech_id: "x-1", kind: "main", requested_t: 0, start_t: null, end_t: null, ended_at: null, end_reason: null });
    await legs.started(tx, a.id, 0.5);
    await legs.ended(tx, a.id, { endT: 30, reason: "error" });
    const b = await legs.open(tx, s.id, { speechId: "x-2", kind: "gap", requestedT: 30 });
    expect((await legs.latest(tx, s.id))?.id).toBe(b.id);
    await legs.started(tx, b.id, 30);
    expect((await legs.latest(tx, s.id))?.start_t).toBe(30);

    const g2 = await gaps.add(tx, s.id, 50, 60);
    const g1 = await gaps.add(tx, s.id, 10, 20);
    const g3 = await gaps.add(tx, s.id, 70, 80);
    await gaps.filled(tx, g3.id);
    expect((await gaps.open(tx, s.id)).map((g) => g.id)).toEqual([g1.id, g2.id]);
    expect(g1).toMatchObject({ t0: 10, t1: 20, filled_at: null });

    expect(await sessions.remove(tx, s.id)).toBe(true);
    expect((await tx.query("select 1 from session_legs where session_id = $1", [s.id])).rowCount).toBe(0);
    expect((await tx.query("select 1 from session_gaps where session_id = $1", [s.id])).rowCount).toBe(0);
  });
});
