import { describe, expect, it } from "vitest";

import { cleanFeedQuery, isUuid } from "./guard";

const clean = (q: string) => cleanFeedQuery(new URLSearchParams(q));

describe("cleanFeedQuery", () => {
  it("keeps the feed's keys in one order, so equal questions share a cache entry", () => {
    expect(clean("min_importance=4&kind=fact&before=120")).toBe("before=120&kind=fact&min_importance=4");
    expect(clean("kind=fact&min_importance=4&before=120")).toBe("before=120&kind=fact&min_importance=4");
  });

  it("drops keys the backend does not know, so junk cannot bust the cache", () => {
    expect(clean("kind=fact&x=1&nonce=abc")).toBe("kind=fact");
    expect(clean("bust=12345")).toBe("");
  });

  it("refuses a malformed known key before it reaches the backend", () => {
    expect(clean("kind=rumour")).toBeNull();
    expect(clean("before=-1")).toBeNull();
    expect(clean("min_importance=9")).toBeNull();
    expect(clean("session=not-a-uuid")).toBeNull();
  });

  it("passes the Monitor's day and stage, and refuses them malformed", () => {
    expect(clean("stage=11111111-1111-1111-1111-111111111111&day=2026-11-12")).toBe("stage=11111111-1111-1111-1111-111111111111&day=2026-11-12");
    expect(clean("day=12-11-2026")).toBeNull();
    expect(clean("stage=main")).toBeNull();
  });

  it("passes a session uuid", () => {
    expect(clean("session=0b6f2c1e-3c3a-4f7e-9a51-2a9f0e5f6d11")).toBe("session=0b6f2c1e-3c3a-4f7e-9a51-2a9f0e5f6d11");
  });
});

describe("isUuid", () => {
  it("tells a video id from anything else", () => {
    expect(isUuid("0b6f2c1e-3c3a-4f7e-9a51-2a9f0e5f6d11")).toBe(true);
    expect(isUuid("abc")).toBe(false);
    expect(isUuid("../people")).toBe(false);
  });
});
