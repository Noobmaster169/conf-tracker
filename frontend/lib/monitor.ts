import type { Stage } from "@/lib/api/conference";
import type { TalkCard, VideoCard } from "@/lib/api/views";
import { plannedTime } from "@/lib/format";

/**
 * The Monitor's shape: the tracked videos by day, and each day's videos by stage. A video's day is its stage's, or the
 * day it started (UTC) when it has none; the api's feed filters claims by the same rule (`day`), so the two agree.
 */

export const isLiveVideo = (video: VideoCard): boolean => ["live", "starting", "recovering"].includes(video.session.status);

export function videoDay(video: VideoCard): string {
  return video.stage?.day ?? (video.session.started_at ?? video.session.created_at).slice(0, 10);
}

export interface StageGroup {
  /** The stage's id, or `video-<session id>` for a video with no stage. */
  key: string;
  stage: Stage | null;
  name: string;
  /** The video the card shows: the live one, else the newest. */
  lead: VideoCard;
  live: boolean;
}

export interface MonitorDay {
  day: string;
  groups: StageGroup[];
  live: boolean;
}

/** Days oldest first, as the Sessions page has them; within a day the stages by name, so a card never moves under a reader. */
export function monitorDays(videos: VideoCard[]): MonitorDay[] {
  const days = new Map<string, Map<string, VideoCard[]>>();
  for (const video of videos) {
    const day = videoDay(video);
    const groups = days.get(day) ?? new Map<string, VideoCard[]>();
    days.set(day, groups);
    const key = video.stage?.id ?? `video-${video.session.id}`;
    groups.set(key, [...(groups.get(key) ?? []), video]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, groups]) => {
      const list = [...groups.entries()]
        .map(([key, vids]): StageGroup => {
          const newest = [...vids].sort((a, b) => (b.session.started_at ?? b.session.created_at).localeCompare(a.session.started_at ?? a.session.created_at));
          const lead = newest.find(isLiveVideo) ?? newest[0]!;
          return { key, stage: lead.stage, name: lead.stage?.name ?? lead.session.title ?? "Untitled video", lead, live: isLiveVideo(lead) };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
      return { day, groups: list, live: list.some((g) => g.live) };
    });
}

/** With nothing asked for: the day something is live on, then today, then the most recent day. */
export function defaultDay(days: MonitorDay[], today = new Date().toISOString().slice(0, 10)): MonitorDay | undefined {
  return days.find((d) => d.live) ?? days.find((d) => d.day === today) ?? [...days].reverse().find((d) => d.day < today) ?? days.at(-1);
}

/** The feed's filter for a day and, optionally, one of its stages. */
export function feedScope(day: string, group: StageGroup | null): Record<string, string> {
  if (!group) return { day };
  return group.stage ? { day, stage: group.stage.id } : { day, session: group.lead.session.id };
}

export const monitorHref = (day: string, stage?: string | null): string =>
  `/?day=${encodeURIComponent(day)}${stage ? `&stage=${encodeURIComponent(stage)}` : ""}`;

/** A session as a stage card shows it: from the schedule when the stage has one, else only what the video knows. */
export interface LineupTalk {
  id: number;
  title: string;
  time: string | null;
  speakers: TalkCard["talk"]["speakers"];
}

/**
 * What a stage card leads with, and what sits either side of it. `now` is the session on stage (a live stage), or the
 * last one it had (an ended stage); a live stage between sessions has none. `before` and `next` are its neighbours in the
 * schedule, nearest first; an ended stage has no `next` unless the schedule says more is still to come.
 */
export interface Lineup {
  now: LineupTalk | null;
  before: LineupTalk | null;
  next: LineupTalk | null;
}

const fromCard = (card: TalkCard): LineupTalk => ({
  id: card.talk.id,
  title: card.talk.title,
  time: plannedTime(card.talk.starts_at, card.talk.ends_at),
  speakers: card.talk.speakers,
});

const bare = (talk: { id: number; title: string } | null): LineupTalk | null => (talk ? { ...talk, time: null, speakers: [] } : null);

export function stageLineup(group: StageGroup, talks: TalkCard[]): Lineup {
  const { lead, live } = group;
  const stageId = group.stage?.id;
  const schedule = stageId ? talks.filter((c) => c.stage.id === stageId && c.talk.kind !== "break").sort((a, b) => a.talk.position - b.talk.position) : [];
  const known = live ? lead.now : lead.last_talk;
  if (schedule.length === 0) return { now: bare(known), before: live && lead.last_talk?.id !== known?.id ? bare(lead.last_talk) : null, next: null };

  const lastEnded = schedule.findLastIndex((c) => c.status === "ended");
  const byId = schedule.findIndex((c) => c.talk.id === known?.id);
  const at = live ? (schedule.findIndex((c) => c.status === "live") >= 0 ? schedule.findIndex((c) => c.status === "live") : byId) : byId >= 0 ? byId : lastEnded;
  // Between sessions on a live stage, the last one that ended stands where the one on now would.
  const pivot = at >= 0 ? at : lastEnded;
  const next = schedule.find((c, i) => i > pivot && c.status !== "ended");
  if (at < 0) return { now: null, before: lastEnded >= 0 ? fromCard(schedule[lastEnded]!) : bare(lead.last_talk), next: next ? fromCard(next) : null };
  return { now: fromCard(schedule[at]!), before: at > 0 ? fromCard(schedule[at - 1]!) : null, next: next ? fromCard(next) : null };
}
