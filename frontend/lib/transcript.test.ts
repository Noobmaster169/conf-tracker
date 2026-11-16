import { expect, test } from "vitest";

import type { Segment, Speaker } from "./api/schemas";
import { PARAGRAPH_CHARS, transcriptTurns } from "./transcript";

const segment = (id: number, t0: number, text: string, voices: (string | null)[]): Segment => ({
  id,
  session_id: "s",
  t0,
  t1: t0 + 2,
  text,
  words: voices.map((speaker_id, i) => ({ w: "x", t0: t0 + i * 0.1, t1: t0 + i * 0.1 + 0.1, p: 1, speaker_id })),
});

const speaker = (speaker_id: string, extra: Partial<Speaker> = {}): Speaker => ({
  speaker_id,
  first_seen_t: 0,
  last_seen_t: 0,
  talk_s: 0,
  merged_into: null,
  name: null,
  role: null,
  name_confidence: null,
  name_quote: null,
  name_call_id: null,
  person_id: null,
  ...extra,
});

test("lines of one voice run together, in time order, and a new voice starts a new turn", () => {
  const turns = transcriptTurns(
    [segment(3, 20, "Thanks.", ["B"]), segment(1, 0, "Hello", ["A", "A"]), segment(2, 10, " everyone. ", ["A", "B", "A"])],
    [speaker("A", { name: "Ann" }), speaker("B")],
    [],
  );
  expect(turns).toEqual([
    { speakerId: "A", name: "Ann", about: null, paragraphs: [{ t0: 0, text: "Hello everyone." }] },
    { speakerId: "B", name: null, about: null, paragraphs: [{ t0: 20, text: "Thanks." }] },
  ]);
});

test("a long turn breaks into paragraphs at line ends, each with its own time", () => {
  const long = "word ".repeat(PARAGRAPH_CHARS / 5).trim() + ".";
  const turns = transcriptTurns([segment(1, 0, long, ["A"]), segment(2, 30, "Next.", ["A"]), segment(3, 35, "More.", ["A"])], [], []);
  expect(turns[0]!.paragraphs).toEqual([
    { t0: 0, text: long },
    { t0: 30, text: "Next. More." },
  ]);
});

test("a merged voice is read as the one it merged into, and a matched person's name and company win", () => {
  const turns = transcriptTurns(
    [segment(1, 0, "One.", ["A2"]), segment(2, 5, "Two.", ["A"])],
    [speaker("A", { name: "Guess", person_id: 7 }), speaker("A2", { merged_into: "A" })],
    [{ id: 7, name: "Ada Lovelace", org: "Analytical", title: "Founder", photo_url: null }],
  );
  expect(turns).toEqual([{ speakerId: "A", name: "Ada Lovelace", about: "Founder, Analytical", paragraphs: [{ t0: 0, text: "One. Two." }] }]);
});

test("a line without a voice, and an empty line", () => {
  const turns = transcriptTurns([segment(1, 0, "Music.", [null]), segment(2, 3, "  ", ["A"])], [], []);
  expect(turns).toEqual([{ speakerId: null, name: null, about: null, paragraphs: [{ t0: 0, text: "Music." }] }]);
});
