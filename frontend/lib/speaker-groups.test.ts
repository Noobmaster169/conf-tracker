import { expect, test } from "vitest";

import type { PersonCard, TalkCard } from "@/lib/api/views";

import { conferencesOf, OTHER } from "./speaker-groups";

const person = (id: number): PersonCard => ({ person: { id, name: `P${id}`, org: null, title: null, photo_url: null }, claim_count: 0, talk_count: 0, last_seen: null });
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
