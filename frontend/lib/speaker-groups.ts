import type { PersonCard, TalkCard } from "@/lib/api/views";

/** The group for people placed at no conference: on no visible schedule, heard in no visible video, listed for none. */
export const OTHER = "other";

export type SpeakerGroup = { conference: string; people: PersonCard[] };

/**
 * People by conference, newest first, so the one on now opens by default. A person belongs to every conference the api
 * places them at (schedule, videos heard in, listings) and every one whose schedule names them; they are listed under
 * each. Conferences the schedule gives no day sort after the dated ones; people placed nowhere come last, under OTHER.
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
  for (const card of people) {
    for (const conference of card.conferences ?? []) {
      const set = conferencesOfPerson.get(card.person.id) ?? new Set<string>();
      set.add(conference);
      conferencesOfPerson.set(card.person.id, set);
      if (!latestDay.has(conference)) latestDay.set(conference, "");
    }
  }
  const order = [...latestDay.entries()].sort(([a, x], [b, y]) => y.localeCompare(x) || a.localeCompare(b)).map(([conference]) => conference);
  const groups = new Map<string, PersonCard[]>([...order, OTHER].map((c) => [c, []]));
  for (const card of people) {
    const conferences = conferencesOfPerson.get(card.person.id);
    for (const conference of conferences?.size ? conferences : [OTHER]) groups.get(conference)!.push(card);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0).map(([conference, list]) => ({ conference, people: list }));
}
