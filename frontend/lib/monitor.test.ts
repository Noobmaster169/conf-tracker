import { describe, expect, test } from "vitest";

import { VideoCard } from "@/lib/api/views";

import { defaultDay, feedScope, monitorDays, videoDay } from "./monitor";

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
