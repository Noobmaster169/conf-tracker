import { expect, test } from "vitest";

import { parseClaimFilter } from "./claim-filters";

test("the claim filter is read from the query, and anything unknown is no filter", () => {
  expect(parseClaimFilter({})).toEqual({ kind: null, major: false });
  expect(parseClaimFilter({ kind: "metric", major: "1" })).toEqual({ kind: "metric", major: true });
  expect(parseClaimFilter({ kind: "gossip", major: "yes" })).toEqual({ kind: null, major: false });
  expect(parseClaimFilter({ kind: ["fact", "metric"] })).toEqual({ kind: null, major: false });
});
