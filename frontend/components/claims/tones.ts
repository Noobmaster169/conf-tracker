import type { Tone } from "@/lib/claims";
import type { LeanTone } from "@/lib/claim-view";

/** Tailwind needs whole class names in source; these are the only ones the explorer builds from a tone. */
export const TONE_TEXT: Record<Tone, string> = { live: "text-live", bad: "text-bad", dim: "text-ink-dim", faint: "text-ink-faint" };
export const TONE_BG: Record<LeanTone, string> = { live: "bg-live", bad: "bg-bad", dim: "bg-ink-dim" };
