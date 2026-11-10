import { expect, test } from "vitest";

import type { Talk } from "../src/contracts";
import { formatSchedule, parseSchedule } from "../src/pipeline/schedule-text";

test("a pasted schedule becomes talks: time, title, speakers with organisation and title, kind", () => {
  const { talks, errors } = parseSchedule(`
# Day 1
10:00-10:30 | Opening keynote | Anatoly Yakovenko, Solana Labs, Co-Founder | keynote
10:30 | The state of DeFi | Jane Doe, Acme, CEO; John Roe, Beta (moderator) | panel
Lunch | | break
Closing remarks
`);
  expect(errors).toEqual([]);
  expect(talks.map((t) => [t.starts_at, t.ends_at, t.title, t.kind])).toEqual([
    ["10:00", "10:30", "Opening keynote", "keynote"],
    ["10:30", null, "The state of DeFi", "panel"],
    [null, null, "Lunch", "break"],
    [null, null, "Closing remarks", "talk"],
  ]);
  expect(talks[0]?.speakers).toEqual([{ name: "Anatoly Yakovenko", org: "Solana Labs", title: "Co-Founder", role: "speaker" }]);
  expect(talks[1]?.speakers).toEqual([
    { name: "Jane Doe", org: "Acme", title: "CEO", role: "speaker" },
    { name: "John Roe", org: "Beta", title: null, role: "moderator" },
  ]);
});

test("a line that cannot be read is named, not skipped", () => {
  const { talks, errors } = parseSchedule("10:00 | Good one\n | Jane Doe\n11:00 | Odd kind | | workshop");
  expect(talks).toHaveLength(1);
  expect(errors).toEqual(["line 2: no title", 'line 3: "workshop" is not one of talk, panel, fireside, keynote, break, other']);
});

test("a schedule written back out parses to the same talks", () => {
  const text = "10:00-10:30 | Opening keynote | Anatoly Yakovenko, Solana Labs, Co-Founder | keynote\n10:30 | Panel | Jane Doe, Acme; John Roe, , Analyst (moderator) | panel";
  const parsed = parseSchedule(text).talks;
  const asTalks: Talk[] = parsed.map((t, i) => ({
    id: i + 1, stage_id: "s", title: t.title, description: "", kind: t.kind, starts_at: t.starts_at, ends_at: t.ends_at, position: i,
    speakers: t.speakers.map((s, j) => ({ id: j + 1, name: s.name, org: s.org, title: s.title, photo_url: null, role: s.role })),
  }));
  expect(parseSchedule(formatSchedule(asTalks)).talks).toEqual(parsed);
});
