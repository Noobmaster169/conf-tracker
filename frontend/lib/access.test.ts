import { expect, test } from "vitest";

import { ACCESS_COOKIE, accessToken, hasAccess, safeEqual, safeNext } from "./access";

test("the token for the right password grants access", async () => {
  expect(await hasAccess(await accessToken("hunter2"), "hunter2")).toBe(true);
});

test("a token for another password, a missing cookie or an unset password does not", async () => {
  expect(await hasAccess(await accessToken("old"), "new")).toBe(false);
  expect(await hasAccess(undefined, "hunter2")).toBe(false);
  expect(await hasAccess(await accessToken("hunter2"), undefined)).toBe(false);
  expect(await hasAccess("", "")).toBe(false);
});

test("safeEqual", () => {
  expect(safeEqual("abc", "abc")).toBe(true);
  expect(safeEqual("abc", "abd")).toBe(false);
  expect(safeEqual("abc", "abcd")).toBe(false);
});

test.each([
  ["/session/1", "/session/1"],
  ["/", "/"],
  ["//evil.com", "/"],
  ["/\\evil.com", "/"],
  ["https://evil.com", "/"],
  [undefined, "/"],
])("safeNext(%s) = %s", (input, expected) => {
  expect(safeNext(input)).toBe(expected);
});

test("the access cookie has its own name, so yt-stream's dashboard on another localhost port does not overwrite it", () => {
  expect(ACCESS_COOKIE).toBe("ct_access");
});
