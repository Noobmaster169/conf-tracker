import type { PersonCard, TalkCard } from "@/lib/api/views";

/** The group for people no visible schedule names: introduced by a stream, or only on a hidden stage. */
export const OTHER = "other";

export type SpeakerGroup = { conference: string; people: PersonCard[] };

/**
 * People by the conference whose schedule names them, newest conference first, so the one on now opens by default.
 * Someone on two conferences' schedules is listed under each; people no schedule names come last, under OTHER.
 * The order of `people` is kept inside each group.
 */
export function conferencesOf(people: PersonCard[], talks: TalkCard[]): SpeakerGroup[] {
  const latestDay = new Map<string, string>();
  const conferencesOfPerson = new Map<number, Set<string>>();
  for (const { talk, stage } of talks) {
    const day = stage.day ?? "";
    if ((latestDay.get(stage.conference) ?? "") <= day) latestDay.set(stage.conference, day);
    for (const speaker of talk.speakers) {
      const set = conferencesOfPerson.get(speaker.id) ?? new Set<string>();
      set.add(stage.conference);
      conferencesOfPerson.set(speaker.id, set);
    }
  }
  const order = [...latestDay.entries()].sort(([, a], [, b]) => b.localeCompare(a)).map(([conference]) => conference);
  const groups = new Map<string, PersonCard[]>([...order, OTHER].map((c) => [c, []]));
  for (const card of people) {
    const conferences = conferencesOfPerson.get(card.person.id);
    for (const conference of conferences?.size ? conferences : [OTHER]) groups.get(conference)!.push(card);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0).map(([conference, list]) => ({ conference, people: list }));
}
