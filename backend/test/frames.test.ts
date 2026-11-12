import request from "supertest";
import { afterAll, expect, test } from "vitest";

import { createApp } from "../src/app";
import { closePool } from "../src/db";
import { createFramer } from "../src/frames/framer";
import type { Grab, Media } from "../src/frames/media";
import { SIG_CELLS } from "../src/frames/signature";
import type { FrameStore } from "../src/frames/store";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as sessions from "../src/repositories/sessions";
import * as spans from "../src/repositories/spans";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const auth = { authorization: "Bearer test-key" };
const URL = "https://www.youtube.com/watch?v=abc123def45";
const shot = (v: number): Grab => ({ image: new Uint8Array([v]), thumb: new Uint8Array([v, v]), sig: new Uint8Array(SIG_CELLS).fill(v), width: 1280, height: 720 });

function fakes(pictures: number[]) {
  const puts: string[] = [];
  const store: FrameStore = { put: async (key) => void puts.push(key), url: (key) => `https://pub.example/${key}` };
  let i = 0;
  const media: Media = {
    resolve: async () => ({ live: true, media: "https://manifest.example/live.m3u8" }),
    grabLive: async () => shot(pictures[Math.min(i++, pictures.length - 1)]!),
    sample: async () => 0,
    encode: async () => shot(0),
  };
  return { store, media, puts };
}
const runner = (live: string[]): SessionRunner => ({ start: () => Promise.reject(new Error("no")), stop: () => Promise.reject(new Error("no")), resume: () => Promise.reject(new Error("no")), resumeAll: () => Promise.resolve([]), live: () => live, busy: () => live, hold: () => {}, fillGap: () => Promise.resolve(false), pending: () => [], wanted: () => false });

test("a live video gets one frame per settled picture, in its talk's gallery and not in a break", async () => {
  await inRollback(async (tx) => {
    const v = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    await tx.query("update sessions set status = 'live' where id = $1", [v.id]);
    // The broadcast began 100 s before "now".
    await tx.query(`insert into events (session_id, seq, type, payload) values ($1, 1, 'session.started', '{"broadcast_start": 1000}')`, [v.id]);
    const stage = await stages.create(tx, { conference: "Test Conf", name: "Main", day: "2026-11-16", description: "" });
    const talk = await talks.create(tx, stage.id, { title: "Keynote", description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [] });
    await spans.switchTo(tx, v.id, { talkId: talk.id, state: "talk", t: 0, confidence: 0.9, quote: null, source: "admin", callId: null });

    const { store, media, puts } = fakes([30, 30, 200, 200, 30, 30]);
    let clock = 1100_000;
    const framer = createFramer({ db: tx, media, store, live: () => [v.id], now: () => clock });
    for (let k = 0; k < 6; k++) {
      await framer.pass();
      clock += 10_000;
    }
    // 30 settles (kept), 200 settles (kept), 30 again: the same as the first, dropped.
    expect(puts).toHaveLength(4);
    const app = createApp({ db: tx, hub: createHub(10), runner: runner([v.id]), framer, frameUrl: store.url });
    const gallery = (await request(app).get(`/sessions/${v.id}/frames`).set(auth)).body;
    expect(gallery).toHaveLength(2);
    expect(gallery[0]).toMatchObject({ talk_id: talk.id, url: expect.stringMatching(/^https:\/\/pub\.example\/frames\//), width: 1280 });
    expect(gallery[0].t).toBeCloseTo(94, 0);
    expect((await request(app).get(`/talks/${talk.id}/frames`).set(auth)).body).toHaveLength(2);

    // A break from 110 s takes the second frame out of the gallery.
    await spans.switchTo(tx, v.id, { talkId: null, state: "break", t: 110, confidence: 0.9, quote: null, source: "admin", callId: null });
    expect((await request(app).get(`/sessions/${v.id}/frames`).set(auth)).body).toHaveLength(1);
    expect((await request(app).get(`/sessions/${v.id}/frames?all=1`).set(auth)).body).toHaveLength(2);

    // Blocking the first hides it.
    const blocked = await request(app).patch(`/frames/${gallery[0].id}`).set(auth).send({ block: true });
    expect(blocked.body).toMatchObject({ hidden: true, blocked: true });
    expect((await request(app).get(`/sessions/${v.id}/frames`).set(auth)).body).toHaveLength(0);
  });
});

test("the settings are read, patched, refused when wrong, and a null takes a key back to its default", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(10), runner: runner([]) });
    const before = await request(app).get("/ops/frames").set(auth);
    expect(before.body).toMatchObject({ configured: false, settings: { enabled: true, interval_s: 10 } });
    expect((await request(app).patch("/ops/frames").set(auth).send({ set: { interval_s: 15, fine_frac: 0.05 } })).body.settings).toMatchObject({ interval_s: 15, fine_frac: 0.05 });
    expect((await request(app).patch("/ops/frames").set(auth).send({ set: { interval_s: 1 } })).status).toBe(400);
    expect((await request(app).patch("/ops/frames").set(auth).send({ set: { nope: 1 } })).status).toBe(400);
    expect((await request(app).patch("/ops/frames").set(auth).send({ set: { interval_s: null } })).body.settings.interval_s).toBe(10);
    expect((await request(app).post("/sessions/x/frames/fill").set(auth).send({})).status).toBe(503);
  });
});

test("a replay gets no frames: not grabbed while it runs, and a fill is refused", async () => {
  await inRollback(async (tx) => {
    const original = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {} });
    const replay = await sessions.create(tx, { sourceUrl: URL, sourceFile: null, config: {}, replayOf: original.id });
    await tx.query("update sessions set status = 'live' where id = $1", [replay.id]);
    const { store, media, puts } = fakes([30, 30, 200, 200]);
    let resolved = 0;
    const counting: Media = { ...media, resolve: async (u) => (resolved++, media.resolve(u)) };
    const framer = createFramer({ db: tx, media: counting, store, live: () => [replay.id] });
    for (let k = 0; k < 4; k++) await framer.pass();
    expect(resolved).toBe(0);
    expect(puts).toHaveLength(0);
    await expect(framer.startFill(replay.id)).rejects.toThrow(/replay/);
  });
});
