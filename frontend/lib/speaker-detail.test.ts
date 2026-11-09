import { expect, test } from "vitest";

import type { SpeakerDetail } from "./api/schemas";
import { detailRows } from "./speaker-detail";

const speaker = { speaker_id: "S2", first_seen_t: 0, last_seen_t: 30, talk_s: 12, merged_into: null, name: null, role: null, name_confidence: null, name_quote: null, name_call_id: null };

function window(id: number, t0: number, matches: SpeakerDetail["windows"][number]["matches"]) {
  return { id, t0, t1: t0 + 10, gpu_ms: 40, matches };
}

test("rows run newest first and pick this speaker's match", () => {
  const detail: SpeakerDetail = {
    speaker,
    proposals: [],
    windows: [
      window(1, 0, [{ local: "SPEAKER_00", speech_s: 4, speaker_id: "S2", scores: {}, new: true }]),
      window(2, 10, [
        { local: "SPEAKER_00", speech_s: 3, speaker_id: "S1", scores: { S1: 0.8 }, new: false },
        { local: "SPEAKER_01", speech_s: 5, speaker_id: "S2", scores: { S1: 0.2, S2: 0.7, S3: 0.4 }, new: false },
      ]),
    ],
  };
  const rows = detailRows(detail, "S2");
  expect(rows.map((r) => r.windowId)).toEqual([2, 1]);
  expect(rows[0].match?.local).toBe("SPEAKER_01");
  expect(rows[0].scores).toEqual([
    { id: "S2", score: 0.7, own: true },
    { id: "S3", score: 0.4, own: false },
    { id: "S1", score: 0.2, own: false },
  ]);
  expect(rows[1].match?.new).toBe(true);
  expect(rows[1].scores).toEqual([]);
});

test("a window without this speaker has no match and no scores", () => {
  const detail: SpeakerDetail = { speaker, proposals: [], windows: [window(1, 0, [{ local: "A", speech_s: 1, speaker_id: "S9", scores: { S2: 0.1 }, new: false }])] };
  expect(detailRows(detail, "S2")[0]).toMatchObject({ match: null, scores: [] });
});

test("caps at 30 windows", () => {
  const detail: SpeakerDetail = { speaker, proposals: [], windows: Array.from({ length: 40 }, (_, i) => window(i, i * 10, [])) };
  const rows = detailRows(detail, "S2");
  expect(rows).toHaveLength(30);
  expect(rows[0].windowId).toBe(39);
});
