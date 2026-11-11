import type { DiarTurnsEvent, Speaker, SpeakerMergedEvent, SpeakerNewEvent, SpeechWord, Word } from "../contracts";
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
  /** The talk time stored before this tracker's leg: what its own windows add to (a reopened leg starts at 0 otherwise). */
  seedTalk(stored: Speaker[]): void;
}

/**
 * One per leg of a live video: holds the recent windows so every word is labelled by the newest verdict. With `live`,
 * every write first checks it, so a leg that was stopped or replaced while a handler awaited writes nothing more.
 */
export function createSpeakerTracker({ db, hub, sessionId, live = () => true }: { db: Queryable; hub: Hub; sessionId: string; live?: () => boolean }): SpeakerTracker {
  let timeline = emptyTimeline();
  const published = new Map<string, number>();
  // Talk seconds stored before this leg, per surviving label; this leg's windows add to it.
  const base = new Map<string, number>();
  const total = (legTalk: Record<string, number>, id: string) => Math.round(((base.get(id) ?? 0) + (legTalk[id] ?? 0)) * 10) / 10;

  async function refresh(id: string, range: { first: number; last: number } | null, talk: number): Promise<void> {
    if (!live()) return;
    const stored = range ? null : await speakers.get(db, sessionId, id);
    if (!range && !stored) return;
    if (!live()) return;
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
      if (!live()) return;
      await diarization.insertWindow(db, sessionId, { t0: window.t0, t1: window.t1, gpuMs: gpu_ms, matches, turns });
      timeline = pushWindow(timeline, { t0: window.t0, t1: window.t1, turns });
      const now = currentTurns(timeline);
      for (const segment of await segments.overlapping(db, sessionId, window.t0, window.t1)) {
        const words = assignWords(segment.words, now);
        if (sameSpeakers(segment.words, words)) continue;
        if (!live()) return;
        hub.publish(sessionId, { type: "segment.updated", data: await segments.updateWords(db, segment.id, words) });
      }
      const legTalk = talkSeconds(timeline);
      const ranges = new Map<string, { first: number; last: number }>();
      for (const t of turns) {
        const id = resolve(timeline, t.speaker_id);
        const r = ranges.get(id);
        ranges.set(id, { first: Math.min(r?.first ?? t.t0, t.t0), last: Math.max(r?.last ?? t.t1, t.t1) });
      }
      const changed = new Set([...ranges.keys(), ...Object.keys(legTalk).filter((id) => published.get(id) !== total(legTalk, id))]);
      for (const id of changed) await refresh(id, ranges.get(id) ?? null, total(legTalk, id));
      if (!live()) return;
      hub.publish(sessionId, { type: "turns", data: { window, turns: now.filter((t) => t.t1 > window.t0) } });
    },

    async onNew(event) {
      if (!live()) return;
      const speaker = await speakers.upsert(db, sessionId, { speakerId: event.speaker_id, firstSeenT: event.first_seen_t, lastSeenT: event.first_seen_t });
      hub.publish(sessionId, { type: "speaker", data: speaker });
    },

    async onMerged(event) {
      timeline = addAlias(timeline, event.speaker_id, event.into);
      // The absorbed voice's earlier talk now counts for the survivor.
      const absorbed = base.get(event.speaker_id) ?? 0;
      base.delete(event.speaker_id);
      if (absorbed > 0) base.set(event.into, (base.get(event.into) ?? 0) + absorbed);
      if (!live()) return;
      const gone = await speakers.markMerged(db, sessionId, event.speaker_id, event.into);
      if (gone) hub.publish(sessionId, { type: "speaker", data: gone });
      // The survivor keeps the more confident name; refresh below publishes it with the widened range.
      await speakers.inheritName(db, sessionId, event.speaker_id, event.into);
      const kept = await speakers.get(db, sessionId, event.into);
      const range = kept && {
        first: Math.min(kept.first_seen_t, gone?.first_seen_t ?? kept.first_seen_t),
        last: Math.max(kept.last_seen_t, gone?.last_seen_t ?? kept.last_seen_t),
      };
      await refresh(event.into, range, total(talkSeconds(timeline), event.into));
    },

    seedTalk(stored) {
      base.clear();
      // A merged row's talk is already in its survivor's.
      for (const s of stored) if (s.merged_into === null && s.talk_s > 0) base.set(s.speaker_id, s.talk_s);
    },
  };
}
