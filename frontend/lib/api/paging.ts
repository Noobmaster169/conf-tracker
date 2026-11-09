/**
 * Reading every row from a list route that stops at a page. Pure: the fetchers are passed in, so the stepping is
 * testable without the backend.
 */

// The repositories' default `limit` for GET /sessions/:id/transcript and /claims; neither route takes a limit.
export const PAGE_ROWS = 1000;

/**
 * Every row of a route ordered by `t0` whose `from` is inclusive: each next page starts at the last row's `t0`, and
 * the rows it repeats from there are dropped by id.
 */
export async function pageByT0<T extends { id: number; t0: number }>(fetchFrom: (from: number) => Promise<T[]>, pageRows = PAGE_ROWS): Promise<T[]> {
  const seen = new Set<number>();
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const page = await fetchFrom(from);
    const fresh = page.filter((row) => !seen.has(row.id));
    for (const row of fresh) seen.add(row.id);
    out.push(...fresh);
    if (page.length < pageRows) return out;
    if (fresh.length === 0) throw new Error(`more than ${pageRows} rows start at t0 ${from}`);
    from = page.at(-1)!.t0;
  }
}

/**
 * Every row of a route that filters on an inclusive `t0` range but orders by id, so a full page is not a prefix in
 * time and cannot be continued. A full range is split in two until each half fits a page; the rows both halves share
 * (at the split point, and the timeless ones every range includes) are dropped by id. `endS` is where the stream's
 * times stop; the open tail past it is read as one range.
 */
export async function pageByRange<T extends { id: number }>(
  fetchRange: (from: number, to: number) => Promise<T[]>,
  endS: number,
  pageRows = PAGE_ROWS,
): Promise<T[]> {
  const byId = new Map<number, T>();
  const read = async (from: number, to: number): Promise<void> => {
    const rows = await fetchRange(from, to);
    if (rows.length >= pageRows) {
      if (to === Number.MAX_SAFE_INTEGER && from < endS) {
        await Promise.all([read(from, endS), read(endS, to)]);
        return;
      }
      if (to - from < 0.01 || to === Number.MAX_SAFE_INTEGER) throw new Error(`more than ${pageRows} rows between t0 ${from} and ${to}`);
      const mid = (from + to) / 2;
      await Promise.all([read(from, mid), read(mid, to)]);
      return;
    }
    for (const row of rows) byId.set(row.id, row);
  };
  await read(0, Number.MAX_SAFE_INTEGER);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}
