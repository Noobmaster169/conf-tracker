import { expect, test } from "vitest";

import { isStoredPhoto, photoSrc } from "./photo";

test("a stored photo is read through this app, keeping its version; a pasted link is used as it is", () => {
  expect(photoSrc("/people/12/photo?v=1794300000000")).toBe("/api/photo/12?v=1794300000000");
  expect(photoSrc("/people/12/photo")).toBe("/api/photo/12");
  expect(photoSrc("https://example.com/a.jpg")).toBe("https://example.com/a.jpg");
  expect(photoSrc(null)).toBeNull();
  expect([isStoredPhoto("/people/12/photo?v=1"), isStoredPhoto("https://example.com/a.jpg"), isStoredPhoto(null)]).toEqual([true, false, false]);
});
