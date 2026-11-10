import type { Span, Stage, Talk } from "../contracts";
import type { Line } from "./lines";
import { mmss, renderLine } from "./window";

/** The attention layer's pure parts: what the tracker is shown, and when a read changes what is believed to be on stage. */

export const speakerList = (talk: Talk): string =>
  talk.speakers.map((s) => `${s.name}${[s.title, s.org].some(Boolean) ? ` (${[s.title, s.org].filter(Boolean).join(", ")})` : ""}${s.role === "speaker" ? "" : ` [${s.role}]`}`).join("; ") || "(none listed)";

const planned = (talk: Talk): string => (talk.starts_at ? `${talk.starts_at}${talk.ends_at ? `-${talk.ends_at}` : ""}` : "no time");

export function stageLine(stage: Stage): string {
  return `${stage.conference}, ${stage.name}${stage.description ? `. ${stage.description}` : ""}`;
}

export interface TrackInput {
  stage: Stage;
  schedule: Talk[];
  /** The span running now, if any, and the ids of talks that already had a span. */
  running: Span | null;
  seen: ReadonlySet<number>;
  lines: Line[];
  names: ReadonlyMap<string, string>;
  now: number;
}

/** The user message: the sections agents/prompts/track names, in this order. */
export function renderTrackInput(input: TrackInput): string {
  const { stage, schedule, running, seen, lines, names, now } = input;
  const rows = schedule.map((talk) => {
    const status = running?.talk_id === talk.id ? "ON STAGE (current belief)" : seen.has(talk.id) ? "already happened" : "not yet seen";
    const about = talk.description ? ` | about: ${talk.description}` : "";
    return `T${talk.id} | ${planned(talk)} | ${talk.kind} | "${talk.title}" | speakers: ${speakerList(talk)}${about} | ${status}`;
  });
  const current = schedule.find((talk) => talk.id === running?.talk_id);
  const belief = !running
    ? "nothing identified yet"
    : running.state === "break"
      ? `a break, since ${mmss(running.t0)}`
      : `T${running.talk_id} "${current?.title ?? "unknown"}", since ${mmss(running.t0)} (${Math.round((now - running.t0) / 60)} min so far)`;
  return [
    `## stage\n${stageLine(stage)}`,
    `## schedule (planned order and times; the real day drifts)\n${rows.join("\n")}`,
    `## current belief\n${belief}`,
    `## transcript (the last few minutes, ending at ${mmss(now)})\n${lines.map((l) => renderLine(l, names)).join("\n")}`,
  ].join("\n\n");
}

/** One read of the stage, after the talk id was checked against the schedule and the quote against the transcript. */
export interface Read {
  state: "talk" | "break" | "unknown";
  talkId: number | null;
  confidence: number;
  /** Where the evidence line starts, when the quote was found: the moment the change happened. */
  quoteT0: number | null;
  /** The stream time of the read. */
  t: number;
}

export type Decision =
  | { kind: "keep"; pending: Read | null }
  | { kind: "switch"; state: "talk" | "break"; talkId: number | null; t: number; confidence: number };

// Two reads that agree are believed even when neither was sure, but a guess is not a read.
const WEAK_FLOOR = 0.5;

const same = (a: { state: string; talkId: number | null }, b: { state: string; talkId: number | null }): boolean =>
  a.state === b.state && (a.state !== "talk" || a.talkId === b.talkId);

/**
 * Hysteresis. The belief changes on one read that is sure and whose evidence is in the transcript, or on two
 * consecutive reads that agree. The change is dated to where the evidence starts, not to the read, so what was said in a
 * talk's first minute belongs to that talk.
 */
export function decide(running: Span | null, pending: Read | null, read: Read, switchConfidence: number): Decision {
  if (read.state === "unknown" || read.confidence < WEAK_FLOOR) return { kind: "keep", pending: null };
  if (running && same({ state: running.state, talkId: running.talk_id }, read)) return { kind: "keep", pending: null };
  const change = { kind: "switch" as const, state: read.state, talkId: read.state === "talk" ? read.talkId : null, confidence: read.confidence };
  if (read.confidence >= switchConfidence && read.quoteT0 !== null) return { ...change, t: read.quoteT0 };
  if (pending && same(pending, read)) return { ...change, t: pending.quoteT0 ?? read.quoteT0 ?? pending.t };
  return { kind: "keep", pending: read };
}
