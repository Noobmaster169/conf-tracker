import { expect, test } from "vitest";

import { markQuote } from "./quote-mark";

const text = "## new lines\n[00:30 S11] The Fed will cut in   December, I think\n[00:36 --] and oil is heading higher.";

test("marks the quote where it sits, forgiving whitespace differences in both", () => {
  expect(markQuote(text, "The Fed will cut in December")).toEqual({
    before: "## new lines\n[00:30 S11] ",
    hit: "The Fed will cut in   December",
    after: ", I think\n[00:36 --] and oil is heading higher.",
  });
});

test("a quote across a line break is marked across it, prefix included, the last occurrence wins, and a miss is null", () => {
  expect(markQuote(text, "I think and oil")?.hit).toBe("I think\n[00:36 --] and oil");
  expect(markQuote(text, "S11] The Fed")).toBeNull();
  expect(markQuote("oil up. oil up.", "oil up")).toEqual({ before: "oil up. ", hit: "oil up", after: "." });
  expect(markQuote(text, "the Fed will cut")).toBeNull();
  expect(markQuote(text, "   ")).toBeNull();
});

const rendered = [
  "## already extracted",
  "- Oil is heading to 90 dollars.",
  "",
  "## context (already handled, for reference only)",
  "[00:00 S8] Welcome back. The Fed will",
  "",
  "## new lines (extract from these)",
  "[00:30 S11] cut in December, I think",
  "[00:36 --] and oil is heading to ninety dollars.",
].join("\n");

test("a quote across the context and new-lines boundary is found, header skipped", () => {
  expect(markQuote(rendered, "The Fed will cut in December")?.hit).toBe("The Fed will\n\n## new lines (extract from these)\n[00:30 S11] cut in December");
});

test("a quote that appears only in the already-extracted bullets or in a retry's previous answer is not found", () => {
  expect(markQuote(rendered, "Oil is heading to 90 dollars.")).toBeNull();
  const retry = `${rendered}\n\n## your previous answer\n{"claims":[{"claim":"x","quote":"Oil is heading to 90 dollars."}]}\n\n## what was wrong with it\nclaims.0.polarity: bad`;
  expect(markQuote(retry, "Oil is heading to 90 dollars.")).toBeNull();
  expect(markQuote(retry, "oil is heading to ninety dollars")?.hit).toBe("oil is heading to ninety dollars");
});
