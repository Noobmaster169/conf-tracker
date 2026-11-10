import { expect, test } from "vitest";

import type { Speaker } from "./api/schemas";
import { mergedFrom, speakerLabeller } from "./speaker-names";

const speaker = (id: string, extra: Partial<Speaker> = {}): Speaker => ({
  speaker_id: id, first_seen_t: 0, last_seen_t: 0, talk_s: 0, merged_into: null,
  name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null, person_id: null, ...extra,
});

test("a claim by a merged label shows the survivor's name; an unnamed or unlabelled one shows none", () => {
  const roster = [speaker("S1", { name: "Cathie Wood", role: "guest" }), speaker("S7", { merged_into: "S1" }), speaker("S2")];
  const label = speakerLabeller(roster);
  expect(label("S7")).toEqual({ id: "S1", name: "Cathie Wood", role: "guest" });
  expect(label("S2")).toEqual({ id: "S2", name: null, role: null });
  expect(label(null)).toEqual({ id: null, name: null, role: null });
  expect(label("S9")).toEqual({ id: "S9", name: null, role: null });
  expect(mergedFrom(roster, "S1")).toEqual(["S7"]);
});
