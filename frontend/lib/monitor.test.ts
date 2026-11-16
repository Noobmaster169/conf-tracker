import { describe, expect, test } from "vitest";

import { TalkCard, VideoCard } from "@/lib/api/views";

import { defaultDay, feedScope, monitorDays, stageLineup, videoDay } from "./monitor";

const stage = (id: string, name: string, day: string | null) => ({ id, conference: "Conf", name, day, description: "", hidden: false, created_at: "2026-01-01T00:00:00Z" });

function video(id: string, status: string, started: string, st: ReturnType<typeof stage> | null): VideoCard {
  return VideoCard.parse({
    session: { id, source_url: null, source_file: null, video_id: null, status, started_at: started, stopped_at: null, config: {}, models: {}, error: null, created_at: started, stage_id: st?.id ?? null },
    stage: st,
    now: null,
    claim_count: 0,
    duration_s: 0,
  });
}

const MAIN = stage("11111111-1111-1111-1111-111111111111", "Main", "2026-11-12");
const SIDE = stage("22222222-2222-2222-2222-222222222222", "Side", "2026-11-12");

describe("monitorDays", () => {
  test("groups by the stage's day, else the day the video started, and puts the live video at the front of its stage", () => {
    const days = monitorDays([
      video("a", "stopped", "2026-11-12T09:00:00Z", MAIN),
      video("b", "live", "2026-11-12T08:00:00Z", MAIN),
      video("c", "stopped", "2026-11-12T10:00:00Z", SIDE),
      video("d", "stopped", "2026-11-13T09:00:00Z", null),
    ]);
    expect(days.map((d) => d.day)).toEqual(["2026-11-12", "2026-11-13"]);
    expect(days[0]!.groups.map((g) => [g.name, g.lead.session.id, g.live])).toEqual([
      ["Main", "b", true],
      ["Side", "c", false],
    ]);
    expect(days[0]!.live).toBe(true);
    expect(days[1]!.groups[0]!.key).toBe("video-d");
    expect(videoDay(days[1]!.groups[0]!.lead)).toBe("2026-11-13");
  });

  test("opens on the live day, else today, else the latest day before today", () => {
    const days = monitorDays([video("a", "stopped", "2026-11-10T09:00:00Z", null), video("b", "stopped", "2026-11-12T09:00:00Z", null)]);
    expect(defaultDay(days, "2026-11-12")?.day).toBe("2026-11-12");
    expect(defaultDay(days, "2026-11-11")?.day).toBe("2026-11-10");
    expect(defaultDay(days, "2026-11-01")?.day).toBe("2026-11-12");
  });

  test("a stage is asked for by its id, a video without one by its session", () => {
    const [day] = monitorDays([video("v", "stopped", "2026-11-12T09:00:00Z", null), video("w", "stopped", "2026-11-12T09:00:00Z", MAIN)]);
    expect(feedScope("2026-11-12", null)).toEqual({ day: "2026-11-12" });
    expect(feedScope("2026-11-12", day!.groups.find((g) => g.stage)!)).toEqual({ day: "2026-11-12", stage: MAIN.id });
    expect(feedScope("2026-11-12", day!.groups.find((g) => !g.stage)!)).toEqual({ day: "2026-11-12", session: "v" });
  });
});

describe("stageLineup", () => {
  const card = (id: number, position: number, status: "upcoming" | "live" | "ended", kind = "talk") =>
    TalkCard.parse({
      talk: { id, stage_id: MAIN.id, title: `T${id}`, description: "", kind, starts_at: `${9 + position}:00`, ends_at: `${10 + position}:00`, position, speakers: [] },
      stage: MAIN,
      status,
      session_id: null,
      video_id: null,
      t0: null,
      t1: null,
      claim_count: 0,
      headline: null,
    });
  const group = (status: string, now: { id: number; title: string } | null, last: { id: number; title: string } | null) => {
    const g = monitorDays([video("v", status, "2026-11-12T08:00:00Z", MAIN)])[0]!.groups[0]!;
    return { ...g, lead: { ...g.lead, now, last_talk: last } };
  };
  const ids = (l: ReturnType<typeof stageLineup>) => [l.before?.id ?? null, l.now?.id ?? null, l.next?.id ?? null];

  test("a live stage: the session on now, the one before it, and the next one to come, breaks skipped", () => {
    const talks = [card(1, 0, "ended"), card(9, 1, "ended", "break"), card(2, 2, "live"), card(3, 3, "upcoming")];
    const l = stageLineup(group("live", { id: 2, title: "T2" }, null), talks);
    expect(ids(l)).toEqual([1, 2, 3]);
    expect(l.now?.time).toBe("11:00 to 12:00");
  });

  test("a live stage between sessions has nothing on now, the last that ended, and what comes next", () => {
    const talks = [card(1, 0, "ended"), card(2, 1, "upcoming"), card(3, 2, "upcoming")];
    expect(ids(stageLineup(group("live", null, { id: 1, title: "T1" }), talks))).toEqual([1, null, 2]);
  });

  test("an ended stage leads with its last session and has nothing next", () => {
    const talks = [card(1, 0, "ended"), card(2, 1, "ended")];
    expect(ids(stageLineup(group("stopped", null, { id: 2, title: "T2" }), talks))).toEqual([1, 2, null]);
  });

  test("a video without a schedule shows only what the video knows", () => {
    expect(ids(stageLineup(group("live", { id: 7, title: "T7" }, { id: 6, title: "T6" }), []))).toEqual([6, 7, null]);
  });
});
