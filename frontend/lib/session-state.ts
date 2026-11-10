import type { Person, Span, Stage, Talk } from "./api/conference";
import type { CallSummary, Claim, Health, LiveEvent, Segment, Session, Snapshot, Speaker, TurnsUpdate } from "./api/schemas";

export type Connection = "connecting" | "open" | "closed";

const MAX_CLAIMS = 5000;
const MAX_CALLS = 10;

export interface SessionState {
  session: Session;
  segments: Segment[];
  health: Health | null;
  speakers: Speaker[];
  claims: Claim[];
  calls: CallSummary[];
  costUsd: number;
  /** When the page received each live segment (ms); snapshot segments are absent and show at once. */
  arrivals: Record<number, number>;
  revisions: Record<number, number>;
  lastTurns: TurnsUpdate | null;
  stage: Stage | null;
  talks: Talk[];
  spans: Span[];
  people: Person[];
  seq: number;
  connection: Connection;
}

export function initialState(snapshot: Snapshot): SessionState {
  return {
    session: snapshot.session,
    segments: snapshot.segments,
    health: snapshot.health,
    speakers: snapshot.speakers,
    claims: snapshot.claims,
    calls: snapshot.calls,
    costUsd: snapshot.cost_usd,
    arrivals: {},
    revisions: {},
    lastTurns: null,
    stage: snapshot.stage,
    talks: snapshot.talks,
    spans: snapshot.spans,
    people: snapshot.people,
    seq: snapshot.seq,
    connection: "connecting",
  };
}

function upsert(segments: Segment[], segment: Segment): Segment[] {
  const without = segments.filter((s) => s.id !== segment.id);
  const at = without.findIndex((s) => s.t0 > segment.t0);
  if (at === -1) return [...without, segment];
  return [...without.slice(0, at), segment, ...without.slice(at)];
}

function upsertSpeaker(speakers: Speaker[], speaker: Speaker): Speaker[] {
  const next = [...speakers.filter((s) => s.speaker_id !== speaker.speaker_id), speaker];
  return next.sort((a, b) => a.first_seen_t - b.first_seen_t || a.speaker_id.localeCompare(b.speaker_id));
}

/** True when a word someone was already shown saying now reads as someone else; a first label or a merge rename is not a relabel. */
function relabelled(speakers: Speaker[], before: Segment | undefined, after: Segment): boolean {
  if (!before) return false;
  const resolve = speakerResolver(speakers);
  return before.words.some((word, i) => {
    const was = resolve(word.speaker_id);
    return was !== null && was !== resolve(after.words[i]?.speaker_id ?? null);
  });
}

function applyUpdate(state: SessionState, segment: Segment, seq: number): SessionState {
  const flash = relabelled(state.speakers, state.segments.find((s) => s.id === segment.id), segment);
  const revisions = flash ? { ...state.revisions, [segment.id]: seq } : state.revisions;
  return { ...state, seq, segments: upsert(state.segments, segment), revisions };
}

export function applyEvent(state: SessionState, event: LiveEvent, at = 0): SessionState {
  const seq = Math.max(state.seq, event.seq);
  switch (event.type) {
    case "snapshot":
      return { ...initialState(event.data), seq: Math.max(seq, event.data.seq), connection: state.connection };
    case "segment": {
      // A segment the snapshot already delivered is not new to the reader; an arrival would let the delay hide it again.
      const known = event.data.id in state.arrivals || state.segments.some((s) => s.id === event.data.id);
      const arrivals = known ? state.arrivals : { ...state.arrivals, [event.data.id]: at };
      return { ...state, seq, segments: upsert(state.segments, event.data), arrivals };
    }
    case "segment.updated":
      return applyUpdate(state, event.data, event.seq);
    case "speaker":
      return { ...state, seq, speakers: upsertSpeaker(state.speakers, event.data) };
    case "turns":
      return { ...state, seq, lastTurns: event.data };
    case "health":
      return { ...state, seq, health: event.data };
    case "session":
      return { ...state, seq, session: event.data };
    case "claims.new": {
      const known = new Set(state.claims.map((c) => c.id));
      const added = event.data.filter((c) => !known.has(c.id));
      return { ...state, seq, claims: [...state.claims, ...added].slice(-MAX_CLAIMS) };
    }
    case "span":
      return { ...state, seq, spans: [...state.spans.filter((s) => s.id !== event.data.id), event.data].sort((a, b) => a.t0 - b.t0 || a.id - b.id) };
    case "person":
      return { ...state, seq, people: [...state.people.filter((p) => p.id !== event.data.id), event.data] };
    case "call": {
      // A replayed call is in the snapshot's total already; only a call newer than the state adds to it.
      const known = state.calls.some((c) => c.id === event.data.id);
      const add = !known && event.seq > state.seq ? (event.data.cost_usd ?? 0) : 0;
      return { ...state, seq, costUsd: state.costUsd + add, calls: [...state.calls.filter((c) => c.id !== event.data.id), event.data].slice(-MAX_CALLS) };
    }
  }
}

export function setConnection(state: SessionState, connection: Connection): SessionState {
  return { ...state, connection };
}

// A merge cycle in bad data must not hang the render.
const MAX_HOPS = 32;

export function resolveSpeaker(speakers: Speaker[], id: string | null): string | null {
  let current = id;
  for (let hop = 0; current !== null && hop < MAX_HOPS; hop++) {
    const into = speakers.find((s) => s.speaker_id === current)?.merged_into ?? null;
    if (into === null) return current;
    current = into;
  }
  return current;
}

/** Resolves each known id once, so a render that labels every word does not walk the list per word. */
export function speakerResolver(speakers: Speaker[]): (id: string | null) => string | null {
  const resolved = new Map(speakers.map((s) => [s.speaker_id, resolveSpeaker(speakers, s.speaker_id)]));
  return (id) => (id === null ? null : (resolved.get(id) ?? id));
}

/** What is on stage now: the span still running and, when it is a talk, the talk. Null before the tracker has placed anything. */
export function nowOnStage(state: Pick<SessionState, "spans" | "talks">): { span: Span; talk: Talk | null } | null {
  const span = state.spans.findLast((s) => s.t1 === null);
  if (!span) return null;
  return { span, talk: state.talks.find((t) => t.id === span.talk_id) ?? null };
}

/** The talk that was on stage at stream time t. */
export function talkAt(state: Pick<SessionState, "spans" | "talks">, t: number | null): Talk | null {
  if (t === null) return null;
  const span = state.spans.findLast((s) => s.state === "talk" && t >= s.t0 && (s.t1 === null || t < s.t1));
  return state.talks.find((talk) => talk.id === span?.talk_id) ?? null;
}
