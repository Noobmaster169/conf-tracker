import { afterEach, expect, test, vi } from "vitest";

import { fetchSpeakerDetail } from "./speaker-detail";

const detail = {
  speaker: { speaker_id: "S1", first_seen_t: 0, last_seen_t: 5, talk_s: 4, merged_into: null, name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null },
  windows: [],
  proposals: [],
};

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

test("fetches the detail through the app's own route and parses it", async () => {
  const fetch = answer(200, detail);
  const signal = new AbortController().signal;
  await expect(fetchSpeakerDetail("a b", "S1", signal)).resolves.toEqual(detail);
  expect(fetch).toHaveBeenCalledWith("/api/sessions/a%20b/speakers/S1", { signal, cache: "no-store" });
});

test("a refusal surfaces the route's error message, or the status", async () => {
  answer(404, { error: "No such speaker." });
  await expect(fetchSpeakerDetail("s", "S9", new AbortController().signal)).rejects.toThrow("No such speaker.");
  answer(502, "oops");
  await expect(fetchSpeakerDetail("s", "S9", new AbortController().signal)).rejects.toThrow("The speaker detail answered 502.");
});

test("a body outside the contract is refused", async () => {
  answer(200, { speaker: null });
  await expect(fetchSpeakerDetail("s", "S1", new AbortController().signal)).rejects.toThrow("outside the contract");
});
