import { afterAll, expect, test, vi } from "vitest";

import { fakeLlm } from "../src/agents/__fakes__/fake-llm";
import { runExtraction } from "../src/agents/extract";
import { loadPrompt } from "../src/agents/prompts/registry";
import { closePool, getPool } from "../src/db";
import * as calls from "../src/repositories/calls";
import * as sessions from "../src/repositories/sessions";

// The claims of an answered call fail to store, as a dropped connection would leave them.
vi.mock("../src/repositories/claims", async (original) => ({
  ...(await original<typeof import("../src/repositories/claims")>()),
  insertMany: vi.fn(async () => {
    throw new Error("connection reset by peer");
  }),
}));

afterAll(closePool);

test("an answered extract call whose claims fail to store is not stored either: the cursor never passes a window whose claims are missing", async () => {
  // Real commits on the pool (a test transaction would hide whether the call row was rolled back); cleaned up after.
  const db = getPool();
  const s = await sessions.create(db, { sourceUrl: "https://www.youtube.com/watch?v=QB5BNdBFujE", sourceFile: null, config: {} });
  try {
    const line = { segment_id: 1, t0: 30, t1: 36, speaker_id: "S1", text: "The Fed will cut in December" };
    const llm = fakeLlm(JSON.stringify({ claims: [{ claim: "The Fed will cut.", topics: [], polarity: "bearish", quote: "The Fed will cut in December" }] }));
    await expect(runExtraction({ db, llm: llm.client, sessionId: s.id, prompt: loadPrompt("extract", "v3") }, { context: [], fresh: [line], t0: 0, t1: 40 }, [])).rejects.toThrow(/connection reset/);
    expect(await calls.lastAnsweredWindow(db, s.id, "extract")).toBe(0);
  } finally {
    await db.query("delete from llm_calls where session_id = $1", [s.id]);
    await sessions.remove(db, s.id);
  }
});
