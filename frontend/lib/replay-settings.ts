/**
 * Settings worth changing on a replay, with their defaults. Diarization defaults live in speech/src/speech/events.py
 * (SessionConfig); claim and naming defaults in backend/src/contracts.ts (ExtractConfig, NameConfig).
 */
export const REPLAY_SETTINGS: { group: string; items: [key: string, fallback: string][] }[] = [
  { group: "speakers", items: [["match_threshold", "0.6"], ["merge_threshold", "0.75"], ["min_speech_s", "1.5"], ["diar_window_s", "60"], ["diar_step_s", "10"], ["merge_every_s", "120"]] },
  { group: "claims", items: [["extract_model", "sonnet"], ["extract_prompt", "v2"], ["extract_interval_s", "30"], ["extract_max_s", "120"], ["context_tail_s", "60"]] },
  { group: "names", items: [["name_model", "sonnet"], ["name_prompt", "v1"], ["name_interval_s", "60"], ["name_window_s", "180"], ["name_floor", "0.7"]] },
];

export const REPLAY_SPEEDS = [
  { value: 0, label: "max" },
  { value: 4, label: "4×" },
  { value: 1, label: "1×" },
] as const;
