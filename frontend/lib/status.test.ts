import { expect, test } from "vitest";

import type { CallSummary } from "./api/schemas";
import { formatCost, lastCallOf, proxyState } from "./status";

const call = (id: number, step: string, error: string | null = null): CallSummary => ({
  id, session_id: "s", step, prompt_version: "v1", model: "sonnet", window_t0: 0, window_t1: 30, attempt: 1,
  input_tokens: 1, output_tokens: 1, cost_usd: 0.01, latency_ms: 1000, error, claim_count: 0, created_at: "2026-09-29T00:00:00.000Z",
});

test("the feed's head reads the last extract call, and the proxy state reads the last call of any step", () => {
  const calls = [call(1, "extract"), call(2, "name", "llm-proxy unreachable")];
  expect(lastCallOf(calls, "extract")?.id).toBe(1);
  expect(lastCallOf(calls, "name")?.id).toBe(2);
  expect(lastCallOf([], "extract")).toBeUndefined();
  expect(proxyState(calls)).toBe("failed");
  expect(proxyState([...calls, call(3, "extract")])).toBe("ok");
  expect(proxyState([])).toBeNull();
});

test("formatCost keeps three decimals under a dollar and two above", () => {
  expect(formatCost(0)).toBe("$0.000");
  expect(formatCost(0.7042)).toBe("$0.704");
  expect(formatCost(12.345)).toBe("$12.35");
});
