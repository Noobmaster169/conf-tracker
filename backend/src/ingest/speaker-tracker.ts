import type { DiarTurnsEvent, SpeakerMergedEvent, SpeakerNewEvent, SpeechWord, Word } from "../contracts";
import type { Queryable } from "../db";
import { assignWords, sameSpeakers } from "../pipeline/assign";
import { addAlias, currentTurns, emptyTimeline, pushWindow, resolve, talkSeconds } from "../pipeline/timeline";
import type { Hub } from "../realtime/hub";
import * as diarization from "../repositories/diarization";
import * as segments from "../repositories/segments";
import * as speakers from "../repositories/speakers";

export interface SpeakerTracker {
  assign(words: SpeechWord[]): Word[];
  onTurns(event: DiarTurnsEvent): Promise<void>;
  onNew(event: SpeakerNewEvent): Promise<void>;
  onMerged(event: SpeakerMergedEvent): Promise<void>;
}

/** One per live session: holds the recent windows so every word is labelled by the newest verdict. */
export function createSpeakerTracker({ db, hub, sessionId }: { db: Queryable; hub: Hub; sessionId: string }): SpeakerTracker {
  let timeline = emptyTimeline();
  const published = new Map<string, number>();

  async function refresh(id: string, range: { first: number; last: number } | null, talk: number): Promise<void> {
    const stored = range ? null : await speakers.get(db, sessionId, id);
    if (!range && !stored) return;
    const speaker = await speakers.upsert(db, sessionId, {
      speakerId: id,
      firstSeenT: range?.first ?? stored!.first_seen_t,
      lastSeenT: range?.last ?? stored!.last_seen_t,
      talkS: talk,
    });
    published.set(id, talk);
    hub.publish(sessionId, { type: "speaker", data: speaker });
  }

  return {
    assign: (words) => assignWords(words, currentTurns(timeline)),

    async onTurns(event) {
      const { window, turns, matches, gpu_ms } = event;
      await diarization.insertWindow(db, sessionId, { t0: window.t0, t1: window.t1, gpuMs: gpu_ms, matches, turns });
      timeline = pushWindow(timeline, { t0: window.t0, t1: window.t1, turns });
      const now = currentTurns(timeline);
      for (const segment of await segments.overlapping(db, sessionId, window.t0, window.t1)) {
        const words = assignWords(segment.words, now);
        if (sameSpeakers(segment.words, words)) continue;
        hub.publish(sessionId, { type: "segment.updated", data: await segments.updateWords(db, segment.id, words) });
      }
      const talk = talkSeconds(timeline);
      const ranges = new Map<string, { first: number; last: number }>();
      for (const t of turns) {
        const id = resolve(timeline, t.speaker_id);
        const r = ranges.get(id);
        ranges.set(id, { first: Math.min(r?.first ?? t.t0, t.t0), last: Math.max(r?.last ?? t.t1, t.t1) });
      }
      const changed = new Set([...ranges.keys(), ...Object.keys(talk).filter((id) => published.get(id) !== talk[id])]);
      for (const id of changed) await refresh(id, ranges.get(id) ?? null, talk[id] ?? 0);
      hub.publish(sessionId, { type: "turns", data: { window, turns: now.filter((t) => t.t1 > window.t0) } });
    },

    async onNew(event) {
      const speaker = await speakers.upsert(db, sessionId, { speakerId: event.speaker_id, firstSeenT: event.first_seen_t, lastSeenT: event.first_seen_t });
      hub.publish(sessionId, { type: "speaker", data: speaker });
    },

    async onMerged(event) {
      timeline = addAlias(timeline, event.speaker_id, event.into);
      const gone = await speakers.markMerged(db, sessionId, event.speaker_id, event.into);
      if (gone) hub.publish(sessionId, { type: "speaker", data: gone });
      // The survivor keeps the more confident name; refresh below publishes it with the widened range.
      await speakers.inheritName(db, sessionId, event.speaker_id, event.into);
      const kept = await speakers.get(db, sessionId, event.into);
      const range = kept && {
        first: Math.min(kept.first_seen_t, gone?.first_seen_t ?? kept.first_seen_t),
        last: Math.max(kept.last_seen_t, gone?.last_seen_t ?? kept.last_seen_t),
      };
      await refresh(event.into, range, talkSeconds(timeline)[event.into] ?? 0);
    },
  };
}
