import request from "supertest";
import { afterAll, expect, it } from "vitest";

import { fakeLlm, type Reply } from "../src/agents/__fakes__/fake-llm";
import { createApp } from "../src/app";
import { closePool, type Queryable } from "../src/db";
import { createHub } from "../src/realtime/hub";
import * as calls from "../src/repositories/calls";
import { aCall, auth, aVideo, runnerWith } from "./agents-helpers";
import { inRollback } from "./db";

afterAll(closePool);

const setup = (db: Queryable, reply?: Reply) => {
  const llm = reply === undefined ? null : fakeLlm(reply);
  const app = createApp({ db, hub: createHub(10), runner: runnerWith(), ...(llm ? { llm: llm.client } : {}) });
  return { llm, app, post: (id: number, body: object = {}) => request(app).post(`/calls/${id}/rerun`).set(auth).set("x-actor", "admin").send(body), get: (id: number) => request(app).get(`/reruns/${id}`).set(auth) };
};
/** The rerun runs in the background of the request; this waits for it to settle. */
async function settled(get: (id: number) => PromiseLike<{ body: { status: string } }>, id: number) {
  for (let i = 0; i < 50; i++) {
    const res = await get(id);
    if (res.body.status !== "pending") return res;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the rerun never settled");
}
const GOOD = JSON.stringify({ claims: [{ claim: "A new claim", topics: [], polarity: "none", quote: "q" }] });

it("answers 202 pending, then done with the new output and parsed_ok", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const call = await aCall(tx, v.id, { input: "the transcript" });
    const { post, get, llm } = setup(tx, GOOD);
    const started = await post(call.id, { prompt_version: "v4", model: "opus" });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ call_id: call.id, status: "pending", prompt_version: "v4", model: "opus", output: null, note: "Uses the text of v4 as it stands now." });
    const done = await settled(get, started.body.id);
    expect(done.body).toMatchObject({ status: "done", output: GOOD, parsed_ok: true, error: null });
    expect(llm!.requests).toHaveLength(1);
    expect(llm!.requests[0]).toMatchObject({ model: "opus", user: "the transcript" });
    expect(llm!.requests[0]!.system).not.toContain("{{schema}}");
    expect(llm!.requests[0]!.outputSchema).toBeDefined();
  });
});

it("defaults to the call's own version and model, and says when the answer does not match the shape", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const call = await aCall(tx, v.id);
    const { post, get, llm } = setup(tx, "not json");
    const started = await post(call.id);
    expect(started.body).toMatchObject({ prompt_version: "v5", model: "sonnet" });
    expect((await settled(get, started.body.id)).body).toMatchObject({ status: "done", output: "not json", parsed_ok: false });
    expect(llm!.requests[0]!.model).toBe("sonnet");
  });
});

it("stores nothing but its event: llm_calls, claims and the extract cursor are unchanged", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const call = await aCall(tx, v.id);
    const count = async (table: string) => Number((await tx.query(`select count(*) n from ${table} where session_id = $1`, [v.id])).rows[0].n);
    const before = [await count("llm_calls"), await count("claims"), await calls.lastAnsweredWindow(tx, v.id, "extract")];
    const { post, get, app } = setup(tx, GOOD);
    const started = await post(call.id);
    await settled(get, started.body.id);
    expect([await count("llm_calls"), await count("claims"), await calls.lastAnsweredWindow(tx, v.id, "extract")]).toEqual(before);
    const opened = await request(app).get(`/calls/${call.id}`).set(auth);
    expect(opened.body.events).toMatchObject([{ kind: "rerun", summary: "Run again with v5 on sonnet", actor: "admin" }]);
  });
});

it("a retry row reruns the first attempt's input", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    await aCall(tx, v.id, { input: "the transcript", error: "claims: Required", parsed: null });
    const second = await aCall(tx, v.id, { attempt: 2, input: "the transcript\n\n## your previous answer\n{}" });
    const { post, get, llm } = setup(tx, GOOD);
    await settled(get, (await post(second.id)).body.id);
    expect(llm!.requests[0]!.user).toBe("the transcript");
  });
});

it("the summarizer → 400; an unknown call → 404; a version that does not exist → 400; no model client → 503", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const summary = await aCall(tx, v.id, { step: "summarize", promptVersion: "v1" });
    const call = await aCall(tx, v.id);
    const { post } = setup(tx, GOOD);
    const refused = await post(summary.id);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/not offered/);
    expect((await post(999_999_999)).status).toBe(404);
    expect((await post(call.id, { prompt_version: "v99" })).status).toBe(400);
    expect((await setup(tx).post(call.id)).status).toBe(503);
  });
});

it("a model failure ends as failed with the error", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const call = await aCall(tx, v.id);
    const { post, get } = setup(tx, new Error("llm-proxy unreachable"));
    expect((await settled(get, (await post(call.id)).body.id)).body).toMatchObject({ status: "failed", error: "llm-proxy unreachable", output: null });
  });
});

it("a pending rerun older than ten minutes reads as interrupted; an unknown rerun → 404", async () => {
  await inRollback(async (tx) => {
    const v = await aVideo(tx);
    const call = await aCall(tx, v.id);
    const { rows } = await tx.query(
      `insert into agent_events (agent_id, session_id, call_id, kind, summary, data, actor, created_at)
       values ('extract', $1, $2, 'rerun', 'Run again with v5 on sonnet', $3, 'admin', now() - interval '11 minutes') returning id`,
      [v.id, call.id, JSON.stringify({ status: "pending", prompt_version: "v5", model: "sonnet" })],
    );
    const { get } = setup(tx, GOOD);
    expect((await get(Number(rows[0].id))).body).toMatchObject({ status: "failed", error: "interrupted" });
    expect((await get(999_999_999)).status).toBe(404);
  });
});
