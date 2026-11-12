import { expect, test } from "vitest";

import type { PersonCard, TalkCard } from "@/lib/api/views";

import { conferencesOf, OTHER } from "./speaker-groups";

const person = (id: number, conferences: string[] = []): PersonCard => ({ person: { id, name: `P${id}`, org: null, title: null, photo_url: null }, claim_count: 0, talk_count: 0, last_seen: null, conferences });
const talk = (conference: string, day: string, speakers: number[]) =>
  ({
    talk: { speakers: speakers.map((id) => ({ ...person(id).person, role: "speaker" })) },
    stage: { conference, day },
  }) as unknown as TalkCard;

test("people are grouped by the conference that schedules them, newest conference first, the unscheduled last", () => {
  const groups = conferencesOf(
    [person(1), person(2), person(3), person(4)],
    [talk("Accelerate", "2026-02-11", [1]), talk("Breakpoint", "2026-11-16", [2, 4]), talk("Accelerate", "2026-02-12", [4])],
  );
  expect(groups.map((g) => [g.conference, g.people.map((p) => p.person.id)])).toEqual([
    ["Breakpoint", [2, 4]],
    ["Accelerate", [1, 4]],
    [OTHER, [3]],
  ]);
});

test("a conference with nobody listed, and an empty other group, are left out", () => {
  expect(conferencesOf([person(1)], [talk("A", "2026-01-01", [1]), talk("B", "2026-02-01", [9])]).map((g) => g.conference)).toEqual(["A"]);
});

test("the api's conferences place people the schedule does not, and a conference with no schedule sorts after the dated ones", () => {
  const groups = conferencesOf(
    [person(1, ["Breakpoint"]), person(2, ["Accelerate", "Breakpoint"]), person(3, ["Side Event"]), person(4)],
    [talk("Breakpoint", "2026-11-16", [9]), talk("Accelerate", "2026-02-11", [9])],
  );
  expect(groups.map((g) => [g.conference, g.people.map((p) => p.person.id)])).toEqual([
    ["Breakpoint", [1, 2]],
    ["Accelerate", [2]],
    ["Side Event", [3]],
    [OTHER, [4]],
  ]);
});
