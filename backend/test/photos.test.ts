import request from "supertest";
import { afterAll, expect, test } from "vitest";

import { createApp } from "../src/app";
import { closePool } from "../src/db";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as people from "../src/repositories/people";
import { inRollback } from "./db";

afterAll(closePool);

const auth = { authorization: "Bearer test-key" };
const noRunner: SessionRunner = { start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => [], busy: () => [], hold: () => {}, fillGap: () => Promise.resolve(false), pending: () => [], wanted: () => false };

test("a stored photo replaces the link, is served back byte for byte, and survives an edit that sends its path", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(100), runner: noRunner });
    const raj = await people.upsertByName(tx, { name: "Raj Gokal", photo_url: "https://example.com/raj.jpg" });
    const png = Buffer.from("89504e470d0a1a0a", "hex");

    const stored = await request(app).put(`/people/${raj.id}/photo`).set(auth).send({ content_type: "image/png", data: png.toString("base64") });
    expect(stored.body).toMatchObject({ id: raj.id, name: "Raj Gokal" });
    expect(stored.body.photo_url).toMatch(new RegExp(`^/people/${raj.id}/photo\\?v=\\d+$`));

    const photo = await request(app).get(stored.body.photo_url).set(auth);
    expect([photo.headers["content-type"], Buffer.compare(photo.body, png)]).toEqual(["image/png", 0]);
    expect(photo.headers["cache-control"]).toContain("immutable");

    const edited = await request(app).put(`/people/${raj.id}`).set(auth).send({ name: "Raj Gokal", org: "Solana Labs", photo_url: stored.body.photo_url });
    expect(edited.body).toMatchObject({ org: "Solana Labs", photo_url: stored.body.photo_url });

    const jpeg = Buffer.from("ffd8ffe0", "hex");
    await request(app).put(`/people/${raj.id}/photo`).set(auth).send({ content_type: "image/jpeg", data: jpeg.toString("base64") });
    expect(Buffer.compare((await request(app).get(`/people/${raj.id}/photo`).set(auth)).body, jpeg)).toBe(0);
  });
});

test("a photo of an unknown type, for nobody, or of nobody is refused", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(100), runner: noRunner });
    const raj = await people.upsertByName(tx, { name: "Raj Gokal" });
    expect((await request(app).put(`/people/${raj.id}/photo`).set(auth).send({ content_type: "image/gif", data: "AAAA" })).status).toBe(400);
    expect((await request(app).put(`/people/${raj.id}/photo`).set(auth).send({ content_type: "image/png", data: "not base64!" })).status).toBe(400);
    expect((await request(app).put("/people/999999/photo").set(auth).send({ content_type: "image/png", data: "AAAA" })).status).toBe(404);
    expect((await request(app).get(`/people/${raj.id}/photo`).set(auth)).status).toBe(404);
    expect((await request(app).put(`/people/${raj.id}`).set(auth).send({ name: "Raj Gokal", photo_url: "/etc/passwd" })).status).toBe(400);
  });
});
