import { expect, test } from "vitest";

import { frameDownloadUrl, frameFileName, isFrameUrl, spread } from "./frames";

const good = "https://pub-31c19b8556f4434ebcd17c97c021ec71.r2.dev/frames/283dbdc6-21c2-4fbf-9230-2a4b26b1e31a/620.0.webp";

test("only a frame image on an R2 public bucket may be fetched", () => {
  expect(isFrameUrl(good)).toBe(true);
  expect(isFrameUrl(good.replace("620.0", "620"))).toBe(true);
  expect(isFrameUrl(good.replace("https:", "http:"))).toBe(false);
  expect(isFrameUrl(good.replace("r2.dev", "example.com"))).toBe(false);
  expect(isFrameUrl(good.replace("/frames/", "/other/"))).toBe(false);
  expect(isFrameUrl(`${good}?x=1`)).toBe(false);
  expect(isFrameUrl("https://evil.r2.dev.example.com/frames/283dbdc6-21c2-4fbf-9230-2a4b26b1e31a/1.webp")).toBe(false);
  expect(isFrameUrl("not a url")).toBe(false);
});

test("a frame's file name is the session's title and the time in it", () => {
  expect(frameFileName("Fireside Chat: Anatoly Yakovenko", 724)).toBe("fireside-chat-anatoly-yakovenko-12-04.webp");
  expect(frameFileName("Café — Ünïcode!", 5)).toBe("cafe-unicode-00-05.webp");
  expect(frameFileName("", 0)).toBe("frame-00-00.webp");
  expect(frameDownloadUrl(good, "a b.webp")).toBe(`/api/frame?u=${encodeURIComponent(good)}&name=a%20b.webp`);
});

test("spread picks evenly, the first included, and never more than there are", () => {
  expect(spread([1, 2, 3], 6)).toEqual([1, 2, 3]);
  expect(spread([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 6)).toEqual([0, 2, 4, 6, 8, 10]);
  expect(spread(Array.from({ length: 20 }, (_, i) => i), 6)[0]).toBe(0);
});
