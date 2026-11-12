import { describe, expect, it } from "vitest";

import { signTicket, verifyTicket } from "../src/ticket";

// The same vector is pinned in frontend/lib/relay-ticket.test.ts: the two sides must agree byte for byte.
const VECTOR = "2000.0e48aa316ff9903351919868e5d203decd684253acc7e60b771413851f0e69b5";

describe("tickets", () => {
  it("signs the fixed vector", () => {
    expect(signTicket("s1", "k", 2000)).toBe(VECTOR);
  });

  it("accepts its own video before it expires", () => {
    expect(verifyTicket(VECTOR, "s1", "k", 1999)).toBe(true);
  });

  it("refuses an expired ticket", () => {
    expect(verifyTicket(VECTOR, "s1", "k", 2001)).toBe(false);
  });

  it("refuses another video's ticket", () => {
    expect(verifyTicket(VECTOR, "s2", "k", 1999)).toBe(false);
  });

  it("refuses a ticket signed with another secret", () => {
    expect(verifyTicket(VECTOR, "s1", "x", 1999)).toBe(false);
  });

  it.each(["garbage", "", "2000.", ".abc", "abc.def", "2000.zz"])("refuses %j without throwing", (bad) => {
    expect(verifyTicket(bad, "s1", "k", 1999)).toBe(false);
  });
});
