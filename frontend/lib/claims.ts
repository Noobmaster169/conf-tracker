import type { CallSummary, Claim, Polarity } from "./api/schemas";
import { formatT } from "./format";

export type Tone = "live" | "bad" | "dim" | "faint";

const GLYPHS: Record<Polarity, { glyph: string; label: string; tone: Tone }> = {
  bullish: { glyph: "▲", label: "bullish", tone: "live" },
  bearish: { glyph: "▼", label: "bearish", tone: "bad" },
  neutral: { glyph: "●", label: "neutral", tone: "dim" },
  none: { glyph: "○", label: "no polarity", tone: "faint" },
};

export function polarityGlyph(polarity: Polarity): { glyph: string; label: string; tone: Tone } {
  return GLYPHS[polarity];
}

/** An unverified claim has no time: the quote was not found, so nothing placed it. */
export function claimTime(claim: Claim): string {
  return claim.t0 === null ? "--:--" : formatT(claim.t0);
}

/** One line at the head of the feed: what the last extraction did, or why it failed. */
export function lastCallLine(call: CallSummary | undefined): { text: string; failed: boolean } | null {
  if (!call) return null;
  const span = `${formatT(call.window_t0)}-${formatT(call.window_t1)}`;
  if (call.error !== null) return { text: `last call ${span} failed: ${call.error}`, failed: true };
  const parts = [`${call.claim_count} ${call.claim_count === 1 ? "claim" : "claims"}`, `${(call.latency_ms / 1000).toFixed(1)}s`];
  if (call.cost_usd !== null) parts.push(`$${call.cost_usd.toFixed(4)}`);
  return { text: `last call ${span} · ${parts.join(" · ")}`, failed: false };
}
