import { expect, test } from "vitest";

import { separateAttributions } from "./summary-markdown";

test("an attribution written straight under its quote is moved to its own paragraph; one already apart is left alone", () => {
  expect(separateAttributions("> The scaling debate is over.\n> \u2014 Mira Voss")).toBe("> The scaling debate is over.\n>\n> \u2014 Mira Voss");
  const apart = "> The scaling debate is over.\n>\n> \u2014 Mira Voss";
  expect(separateAttributions(apart)).toBe(apart);
  expect(separateAttributions("Plain text.\n\u2014 not a quote")).toBe("Plain text.\n\u2014 not a quote");
});
