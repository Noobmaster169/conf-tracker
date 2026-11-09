import { expect, test } from "vitest";

import type { ClaimHit, TopicFacet } from "./api/claim-schemas";
import { dateRange, foldTopics, groupByShow, leanBar, showDate, showLabel, splitMatches, watchUrl } from "./claim-view";

const lean = (bullish: number, bearish: number, neutral: number, none = 0) => ({ bullish, bearish, neutral, none });
const topic = (value: string, count: number): TopicFacet => ({ value, count, lean: lean(count, 0, 0), voices: [] });

test("leanBar scales to the largest count and splits by direction, leaving out none", () => {
  expect(leanBar(lean(2, 1, 1, 4), 8, 16)).toEqual({ width: 0.5, segments: [{ tone: "live", share: 0.5 }, { tone: "bad", share: 0.25 }, { tone: "dim", share: 0.25 }] });
  expect(leanBar(lean(0, 3, 0), 3, 3)).toEqual({ width: 1, segments: [{ tone: "bad", share: 1 }] });
  expect(leanBar(lean(0, 0, 0, 2), 2, 4)).toEqual({ width: 0.5, segments: [] });
  expect(leanBar(lean(0, 0, 0), 0, 0).width).toBe(0);
});

test("foldTopics keeps the top n of the repeated topics, then the rest, then the ones; active ones stay on top", () => {
  const all = [topic("a", 9), topic("b", 5), topic("c", 3), topic("d", 2), topic("e", 1), topic("f", 1)];
  const folded = foldTopics(all, [], 2);
  expect(folded.top.map((t) => t.value)).toEqual(["a", "b"]);
  expect(folded.more.map((t) => t.value)).toEqual(["c", "d"]);
  expect(folded.ones.map((t) => t.value)).toEqual(["e", "f"]);
  const pinned = foldTopics(all, ["f", "c"], 2);
  expect(pinned.top.map((t) => t.value)).toEqual(["a", "b", "c", "f"]);
  expect(pinned.more.map((t) => t.value)).toEqual(["d"]);
  expect(pinned.ones.map((t) => t.value)).toEqual(["e"]);
  expect(foldTopics(all, ["F"], 2).top.map((t) => t.value)).toEqual(["a", "b", "f"]);
});

test("watchUrl links to the second, and only when there is a video and a time", () => {
  expect(watchUrl("QB5BNdBFujE", 4359.8)).toBe("https://www.youtube.com/watch?v=QB5BNdBFujE&t=4359s");
  expect(watchUrl(null, 10)).toBeNull();
  expect(watchUrl("QB5BNdBFujE", null)).toBeNull();
});

test("splitMatches marks every case-insensitive, literal occurrence", () => {
  expect(splitMatches("The Fed and the fed", "fed")).toEqual([
    { text: "The ", hit: false }, { text: "Fed", hit: true }, { text: " and the ", hit: false }, { text: "fed", hit: true },
  ]);
  expect(splitMatches("up 50%.", ".")).toEqual([{ text: "up 50%", hit: false }, { text: ".", hit: true }]);
  expect(splitMatches("nothing here", "")).toEqual([{ text: "nothing here", hit: false }]);
  expect(splitMatches("nothing here", "zz")).toEqual([{ text: "nothing here", hit: false }]);
});

test("showLabel prefers the title, then the video id, then the file, then the session", () => {
  const show = { session_id: "0b8d7a4e-4a3c", video_id: "QB5BNdBFujE", source_file: null };
  expect(showLabel(show, { title: "Bloomberg Surveillance", author: "Bloomberg" })).toBe("Bloomberg Surveillance");
  expect(showLabel(show)).toBe("QB5BNdBFujE");
  expect(showLabel({ ...show, video_id: null, source_file: "/data/runs/walk.wav" })).toBe("walk.wav");
  expect(showLabel({ ...show, video_id: null })).toBe("0b8d7a4e");
});

test("dates read short, and a range folds a shared month", () => {
  expect(showDate("2026-09-28T10:00:00Z")).toBe("Sep 28");
  expect(dateRange([])).toBeNull();
  expect(dateRange([{ created_at: "2026-09-28T10:00:00Z" }])).toBe("Sep 28");
  expect(dateRange([{ created_at: "2026-09-29T10:00:00Z" }, { created_at: "2026-09-22T10:00:00Z" }])).toBe("Sep 22–29");
  expect(dateRange([{ created_at: "2026-09-02T10:00:00Z" }, { created_at: "2026-08-30T10:00:00Z" }])).toBe("Aug 30 – Sep 2");
});

test("groupByShow splits consecutive runs", () => {
  const hit = (id: number, session_id: string) => ({ id, session_id }) as ClaimHit;
  expect(groupByShow([hit(1, "b"), hit(2, "b"), hit(3, "a")]).map((g) => [g.sessionId, g.items.map((i) => i.id)])).toEqual([["b", [1, 2]], ["a", [3]]]);
});
