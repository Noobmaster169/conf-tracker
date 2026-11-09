import { expect, test } from "vitest";

import { chips, claimsHref, EMPTY_FILTERS, isFiltered, parseFilters, set, toggle, toQuery, UNNAMED } from "./claim-filters";

const SID = "0b8d7a4e-4a3c-4f7e-9d1e-2f3a4b5c6d7e";

test("parse reads single and repeated values, and drops what the backend would refuse", () => {
  const f = parseFilters({ q: "  fed cuts ", topic: ["rates", "oil", "rates"], speaker: "Anders Persson", polarity: ["bullish", "up"], session: [SID, "nope"], all: "1" });
  expect(f).toEqual({ q: "fed cuts", topic: ["rates", "oil"], speaker: ["Anders Persson"], polarity: ["bullish"], session: [SID], all: true });
  expect(parseFilters({})).toEqual(EMPTY_FILTERS);
  expect(parseFilters({ all: "yes", topic: "" })).toEqual(EMPTY_FILTERS);
});

test("parse cuts q and drops sessions that are not RFC UUIDs, as the backend would refuse them", () => {
  expect(parseFilters({ q: ` ${"x".repeat(250)} ` }).q).toBe("x".repeat(200));
  expect(parseFilters({ session: [SID, "11111111-1111-1111-1111-111111111111"] }).session).toEqual([SID]);
});

test("toQuery is stable, encodes, and carries paging", () => {
  const f = { ...EMPTY_FILTERS, q: "a&b", topic: ["rates", "oil"], speaker: [UNNAMED], all: true };
  expect(toQuery(f)).toBe("q=a%26b&topic=rates&topic=oil&speaker=%28unnamed%29&all=1");
  expect(toQuery(EMPTY_FILTERS, { offset: 200, limit: 200, as_of: 41 })).toBe("offset=200&limit=200&as_of=41");
  expect(toQuery(EMPTY_FILTERS, { as_of: null })).toBe("");
  expect(parseFilters(Object.fromEntries(new URLSearchParams(toQuery(f)).entries()))).toMatchObject({ q: "a&b", all: true });
});

test("claimsHref has no query when nothing is filtered", () => {
  expect(claimsHref(EMPTY_FILTERS)).toBe("/claims");
  expect(claimsHref({ ...EMPTY_FILTERS, topic: ["oil"] })).toBe("/claims?topic=oil");
});

test("toggle adds and removes one value; set replaces a key", () => {
  const on = toggle(EMPTY_FILTERS, "topic", "oil");
  expect(on.topic).toEqual(["oil"]);
  expect(toggle(on, "topic", "oil").topic).toEqual([]);
  expect(toggle(on, "topic", "rates").topic).toEqual(["oil", "rates"]);
  expect(set(on, "polarity", ["bearish"]).polarity).toEqual(["bearish"]);
  expect(set(on, "polarity", ["up"]).polarity).toEqual([]);
  expect(isFiltered(EMPTY_FILTERS)).toBe(false);
  expect(isFiltered({ ...EMPTY_FILTERS, all: true })).toBe(false);
  expect(isFiltered(on)).toBe(true);
});

test("chips name each active value and link to the view without it", () => {
  const f = { ...EMPTY_FILTERS, q: "fed", topic: ["oil"], speaker: [UNNAMED], polarity: ["bearish" as const], session: [SID] };
  expect(chips(f, { [SID]: "Bloomberg Surveillance" })).toEqual([
    { key: "q", value: "fed", label: "“fed”", href: `/claims?topic=oil&speaker=%28unnamed%29&polarity=bearish&session=${SID}` },
    { key: "topic", value: "oil", label: "topic: oil", href: `/claims?q=fed&speaker=%28unnamed%29&polarity=bearish&session=${SID}` },
    { key: "speaker", value: UNNAMED, label: "speaker: unnamed", href: `/claims?q=fed&topic=oil&polarity=bearish&session=${SID}` },
    { key: "polarity", value: "bearish", label: "lean: bearish", href: `/claims?q=fed&topic=oil&speaker=%28unnamed%29&session=${SID}` },
    { key: "session", value: SID, label: "show: Bloomberg Surveillance", href: "/claims?q=fed&topic=oil&speaker=%28unnamed%29&polarity=bearish" },
  ]);
});

test("topics are lower-case, like the backend's facets", () => {
  expect(parseFilters({ topic: ["Oil", "oil", "RATES"] }).topic).toEqual(["oil", "rates"]);
  expect(toggle(EMPTY_FILTERS, "topic", "Oil").topic).toEqual(["oil"]);
  expect(toggle({ ...EMPTY_FILTERS, topic: ["oil"] }, "topic", "Oil").topic).toEqual([]);
});
