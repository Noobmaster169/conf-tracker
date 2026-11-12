import request from "supertest";
import { afterAll, expect, test } from "vitest";

import { createApp } from "../src/app";
import { closePool } from "../src/db";
import type { SessionRunner } from "../src/ingest/session-runner";
import { createHub } from "../src/realtime/hub";
import * as people from "../src/repositories/people";
import * as sessions from "../src/repositories/sessions";
import * as speakers from "../src/repositories/speakers";
import * as stages from "../src/repositories/stages";
import * as talks from "../src/repositories/talks";
import { inRollback } from "./db";

afterAll(closePool);

const auth = { authorization: "Bearer test-key" };
const noRunner: SessionRunner = { start: () => Promise.reject(new Error("not used")), stop: () => Promise.reject(new Error("not used")), resume: () => Promise.reject(new Error("not used")), resumeAll: () => Promise.resolve([]), live: () => [], busy: () => [], hold: () => {}, fillGap: () => Promise.resolve(false), pending: () => [], wanted: () => false };

type Card = { person: { id: number; name: string }; conferences: string[] };

test("a person's conferences come from a visible schedule, a video they were heard in, and a listing, never a hidden stage", async () => {
  await inRollback(async (tx) => {
    const app = createApp({ db: tx, hub: createHub(100), runner: noRunner });
    const conferenceOf = async (id: number) => ((await request(app).get("/people").set(auth)).body as Card[]).find((c) => c.person.id === id)?.conferences;

    const bp = await stages.create(tx, { conference: "BP Test", name: "Main", day: "2026-11-16", description: "" });
    const hk = await stages.create(tx, { conference: "HK Test", name: "Hall", day: "2026-02-11", description: "" });
    const summit = await stages.create(tx, { conference: "Summit Test", name: "Main", day: "2026-10-06", description: "" });
    await stages.update(tx, summit.id, { conference: "Summit Test", name: "Main", day: "2026-10-06", description: "", hidden: true });

    const talk = await talks.create(tx, bp.id, { title: "Keynote", description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [{ name: "Sched Person", org: null, title: null, role: "speaker" }] });
    await talks.create(tx, summit.id, { title: "Hidden", description: "", kind: "talk", starts_at: null, ends_at: null, speakers: [{ name: "Listed Person", org: null, title: null, role: "speaker" }] });
    const scheduled = talk.speakers[0]!;

    const heard = await people.upsertByName(tx, { name: "Heard Person" });
    const video = await sessions.create(tx, { sourceUrl: "https://www.youtube.com/watch?v=QB5BNdBFujE", sourceFile: null, config: {}, stageId: hk.id, title: "HK day" });
    await speakers.upsert(tx, video.id, { speakerId: "S1", firstSeenT: 0, lastSeenT: 30 });
    await speakers.setPerson(tx, video.id, "S1", { id: heard.id, name: heard.name });

    const listed = await people.upsertByName(tx, { name: "Listed Person" });

    expect(await conferenceOf(scheduled.id)).toEqual(["BP Test"]);
    expect(await conferenceOf(heard.id)).toEqual(["HK Test"]);
    // Only on a hidden stage, made with it: out of the list until listed for a conference.
    expect(await conferenceOf(listed.id)).toBeUndefined();

    expect((await request(app).post(`/people/${listed.id}/conferences`).set(auth).send({ conference: " BP Test " })).status).toBe(204);
    expect((await request(app).post(`/people/${listed.id}/conferences`).set(auth).send({ conference: "BP Test" })).status).toBe(204);
    expect(await conferenceOf(listed.id)).toEqual(["BP Test"]);
    expect((await request(app).post(`/people/${heard.id}/conferences`).set(auth).send({ conference: "BP Test" })).status).toBe(204);
    expect(await conferenceOf(heard.id)).toEqual(["BP Test", "HK Test"]);
    expect((await request(app).get(`/people/${heard.id}`).set(auth)).body.conferences).toEqual(["BP Test", "HK Test"]);

    expect((await request(app).post(`/people/${listed.id}/conferences`).set(auth).send({ conference: "" })).status).toBe(400);
    expect((await request(app).post("/people/999999/conferences").set(auth).send({ conference: "BP Test" })).status).toBe(404);

    expect((await request(app).delete(`/people/${heard.id}/conferences/${encodeURIComponent("BP Test")}`).set(auth)).status).toBe(204);
    expect(await conferenceOf(heard.id)).toEqual(["HK Test"]);
    expect((await request(app).delete(`/people/${heard.id}/conferences/${encodeURIComponent("BP Test")}`).set(auth)).status).toBe(404);
  });
});
