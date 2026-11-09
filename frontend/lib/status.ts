import type { CallSummary } from "./api/schemas";

/** The newest call of one step: the feed's head is about extraction, whatever the namer did since. */
export function lastCallOf(calls: CallSummary[], step: string): CallSummary | undefined {
  return calls.findLast((call) => call.step === step);
}

/** The proxy as the last call of any step found it; null before the first call. */
export function proxyState(calls: CallSummary[]): "ok" | "failed" | null {
  const last = calls.at(-1);
  if (!last) return null;
  return last.error === null ? "ok" : "failed";
}

export function formatCost(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}
