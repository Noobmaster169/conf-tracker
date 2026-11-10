import type { Person, Span, Stage, Talk } from "../contracts";
import type { Queryable } from "../db";
import { speakerList, stageLine } from "../pipeline/tracking";
import * as sessions from "../repositories/sessions";
import * as spans from "../repositories/spans";
import * as stages from "../repositories/stages";
import * as talks from "../repositories/talks";

/** What the schedule says about a video right now. Read fresh on every run, so an edit in the admin area or a correction takes effect at once. */
export interface StageContext {
  stage: Stage;
  schedule: Talk[];
  /** The span running now (or at the time asked about), and the talk it is, when it is one. */
  running: Span | null;
  current: Talk | null;
}

/**
 * Null when the video has no stage: everything then runs as it did before there were schedules. With `at`, the stage
 * as it was at that stream time, for a loop working through a window the tracker has already moved past.
 */
export async function loadStageContext(db: Queryable, sessionId: string, at?: number): Promise<StageContext | null> {
  const session = await sessions.get(db, sessionId);
  if (!session?.stage_id) return null;
  const stage = await stages.get(db, session.stage_id);
  if (!stage) return null;
  const schedule = await talks.forStage(db, stage.id);
  const running = at === undefined ? await spans.open(db, sessionId) : await spans.at(db, sessionId, at);
  return { stage, schedule, running, current: schedule.find((talk) => talk.id === running?.talk_id) ?? null };
}

/** The extractor's "on stage" section. */
export function onStageText(context: StageContext): string {
  const { stage, running, current } = context;
  const lines = [`Conference: ${stageLine(stage)}`];
  if (current) {
    lines.push(`Session: "${current.title}" (${current.kind})${current.description ? `. ${current.description}` : ""}`, `Speakers: ${speakerList(current)}`);
  } else {
    lines.push(running?.state === "break" ? "Session: a break, or between sessions" : "Session: not identified yet");
  }
  return lines.join("\n");
}

/** Everyone the schedule expects on the stage, the running talk's people first. */
export function scheduledPeople(context: StageContext): { person: Person; line: string }[] {
  const seen = new Set<number>();
  const out: { person: Person; line: string }[] = [];
  const ordered = context.current ? [context.current, ...context.schedule.filter((talk) => talk.id !== context.current!.id)] : context.schedule;
  for (const talk of ordered) {
    for (const { role, ...person } of talk.speakers) {
      if (seen.has(person.id)) continue;
      seen.add(person.id);
      const about = [person.title, person.org].filter(Boolean).join(", ");
      const marks = [role === "speaker" ? null : role, talk.id === context.current?.id ? "current session" : null].filter(Boolean).join(", ");
      out.push({ person, line: `${person.name}${about ? `, ${about}` : ""}${marks ? ` (${marks})` : ""}` });
    }
  }
  return out;
}
