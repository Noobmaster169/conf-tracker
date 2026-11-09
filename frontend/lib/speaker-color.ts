const PALETTE_SIZE = 8;

/** Speaker ids are S1, S2, ...; colours cycle through the eight --spk tokens in globals.css. */
export function speakerColor(id: string | null): string {
  const n = id ? Number(/^S(\d+)$/.exec(id)?.[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? `var(--spk-${((n - 1) % PALETTE_SIZE) + 1})` : "var(--ink-dim)";
}
