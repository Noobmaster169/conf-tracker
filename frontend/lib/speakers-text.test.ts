import { expect, test } from "vitest";

import { formatSpeakers, parseSpeakers } from "./speakers-text";

test("speakers are read from one line and written back the same", () => {
  const text = "Anatoly Yakovenko, Solana Labs, Co-Founder; Jane Doe, Acme; John Roe, , Analyst (moderator); Lily Liu (host)";
  const parsed = parseSpeakers(text);
  expect(parsed).toEqual([
    { name: "Anatoly Yakovenko", org: "Solana Labs", title: "Co-Founder", role: "speaker" },
    { name: "Jane Doe", org: "Acme", title: null, role: "speaker" },
    { name: "John Roe", org: null, title: "Analyst", role: "moderator" },
    { name: "Lily Liu", org: null, title: null, role: "host" },
  ]);
  expect(formatSpeakers(parsed.map((s, i) => ({ ...s, id: i, photo_url: null })))).toBe(text);
  expect(parseSpeakers(" ; \n")).toEqual([]);
});
