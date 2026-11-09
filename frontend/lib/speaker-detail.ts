import type { Match, SpeakerDetail } from "./api/schemas";

export interface ScoreCell {
  id: string;
  score: number;
  own: boolean;
}

export interface DetailRow {
  windowId: number;
  t0: number;
  t1: number;
  match: Match | null;
  scores: ScoreCell[];
}

// The backend already caps at 30; this keeps a looser backend from flooding the panel.
const MAX_WINDOWS = 30;

/** Newest window first; within a row the speaker's own score leads, then the rest best first. */
export function detailRows(detail: SpeakerDetail, speakerId: string): DetailRow[] {
  return [...detail.windows]
    .sort((a, b) => b.t1 - a.t1 || b.id - a.id)
    .slice(0, MAX_WINDOWS)
    .map((window) => {
      const match = window.matches.find((m) => m.speaker_id === speakerId) ?? null;
      const scores = Object.entries(match?.scores ?? {})
        .map(([id, score]) => ({ id, score, own: id === speakerId }))
        .sort((a, b) => Number(b.own) - Number(a.own) || b.score - a.score);
      return { windowId: window.id, t0: window.t0, t1: window.t1, match, scores };
    });
}
