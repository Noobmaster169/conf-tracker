import { expect, test } from "vitest";

import { pageByRange, pageByT0 } from "./paging";

// Rows ordered and cut like the repositories' list queries.
const byT0 = (rows: { id: number; t0: number }[], size: number) => (from: number) =>
  Promise.resolve(rows.filter((r) => r.t0 >= from).sort((x, y) => x.t0 - y.t0).slice(0, size));
const byRange = (rows: { id: number; t0: number | null }[], size: number) => (from: number, to: number) =>
  Promise.resolve(rows.filter((r) => r.t0 === null || (r.t0 >= from && r.t0 <= to)).sort((x, y) => x.id - y.id).slice(0, size));

test("pageByT0 reads past the page, once per row, including rows sharing the boundary t0", async () => {
  const rows = [0, 1, 2, 2, 2, 3, 4, 5, 6].map((t0, i) => ({ id: i + 1, t0 }));
  const out = await pageByT0(byT0(rows, 4), 4);
  expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
});

test("pageByT0 stops on a short first page", async () => {
  const rows = [{ id: 1, t0: 0 }];
  expect(await pageByT0(byT0(rows, 3), 3)).toEqual(rows);
});

test("pageByRange splits a full range until each part fits, keeping timeless rows once", async () => {
  // Ids out of time order, as when a later extraction finds an earlier claim.
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: i + 1, t0: (i * 37) % 100 })),
    { id: 21, t0: null },
    { id: 22, t0: 100 },
  ];
  const out = await pageByRange(byRange(rows, 5), 100, 5);
  expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
});

test("pageByRange refuses a pile of rows it cannot split", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, t0: 10 }));
  await expect(pageByRange(byRange(rows, 5), 100, 5)).rejects.toThrow(/more than 5 rows/);
});
