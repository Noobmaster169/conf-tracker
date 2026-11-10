import { expect, test } from "vitest";

import { matchPerson, splitRole } from "../src/pipeline/people-match";

const roster = [{ name: "Anatoly Yakovenko" }, { name: "Lily Liu" }, { name: "Raj Gokal" }, { name: "Lily Chen" }];

test("a heard name is matched to the one scheduled person it means", () => {
  expect(matchPerson("Anatoly Yakovenko", roster)?.name).toBe("Anatoly Yakovenko");
  expect(matchPerson("anatoli yakovenko", roster)?.name).toBe("Anatoly Yakovenko");
  expect(matchPerson("Yakovenko", roster)?.name).toBe("Anatoly Yakovenko");
  expect(matchPerson("Raj", roster)?.name).toBe("Raj Gokal");
});

test("nobody is chosen when the name fits two people, fits none, or is a lone first name spelt differently", () => {
  expect(matchPerson("Lily", roster)).toBeNull();
  expect(matchPerson("Vitalik Buterin", roster)).toBeNull();
  expect(matchPerson("Anatole", roster)).toBeNull();
  expect(matchPerson("", roster)).toBeNull();
});

test("a role splits into title and organisation; running a session is not a title", () => {
  expect(splitRole("Co-Founder, Solana Labs")).toEqual({ title: "Co-Founder", org: "Solana Labs" });
  expect(splitRole("CEO")).toEqual({ title: "CEO", org: null });
  expect(splitRole("moderator")).toEqual({ title: null, org: null });
  expect(splitRole(null)).toEqual({ title: null, org: null });
});
