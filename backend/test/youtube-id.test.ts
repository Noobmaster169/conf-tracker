import { expect, test } from "vitest";

import { videoIdFromUrl } from "../src/lib/youtube-id";

test.each([
  ["https://www.youtube.com/watch?v=QB5BNdBFujE", "QB5BNdBFujE"],
  ["https://youtube.com/watch?v=QB5BNdBFujE&t=10", "QB5BNdBFujE"],
  ["https://m.youtube.com/watch?v=QB5BNdBFujE", "QB5BNdBFujE"],
  ["https://youtu.be/QB5BNdBFujE", "QB5BNdBFujE"],
  ["https://www.youtube.com/live/QB5BNdBFujE?feature=share", "QB5BNdBFujE"],
  ["https://www.youtube.com/embed/QB5BNdBFujE", "QB5BNdBFujE"],
  ["https://www.youtube.com/watch?v=short", null],
  ["https://vimeo.com/12345", null],
  ["not a url", null],
])("videoIdFromUrl(%s)", (url, expected) => {
  expect(videoIdFromUrl(url)).toBe(expected);
});
