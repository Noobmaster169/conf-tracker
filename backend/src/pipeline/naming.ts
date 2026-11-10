import type { Person, ProposalStatus, Speaker } from "../contracts";
import { locateQuote } from "./evidence";
import { sameWord } from "./people-match";
import type { Line } from "./lines";
import { renderLine } from "./window";

// A merge cycle in bad data must not hang a tick.
const MAX_HOPS = 32;

/** The id a label stands for now: merged_into followed to the survivor. Mirrors resolveSpeaker in frontend/lib/session-state.ts. */
export function resolveId(speakers: Speaker[], id: string): string {
  const into = new Map(speakers.map((s) => [s.speaker_id, s.merged_into]));
  let current = id;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = into.get(current) ?? null;
    if (next === null) return current;
    current = next;
  }
  return current;
}

/** Every known label, merged ones included, to the name its survivor goes by. Unnamed labels are absent. */
export function nameMap(speakers: Speaker[]): Map<string, string> {
  const byId = new Map(speakers.map((s) => [s.speaker_id, s]));
  const names = new Map<string, string>();
  for (const s of speakers) {
    const name = byId.get(resolveId(speakers, s.speaker_id))?.name ?? null;
    if (name !== null) names.set(s.speaker_id, name);
  }
  return names;
}

/** nameMap, with the organisation after the name once the speaker is a known person: "Jane Doe, Acme". It is what resolves a "we". */
export function labelMap(speakers: Speaker[], people: Person[]): Map<string, string> {
  const orgs = new Map(people.map((p) => [p.id, p.org]));
  const byId = new Map(speakers.map((s) => [s.speaker_id, s]));
  const labels = new Map<string, string>();
  for (const s of speakers) {
    const survivor = byId.get(resolveId(speakers, s.speaker_id));
    if (!survivor?.name) continue;
    const org = survivor.person_id === null ? null : (orgs.get(survivor.person_id) ?? null);
    labels.set(s.speaker_id, org ? `${survivor.name}, ${org}` : survivor.name);
  }
  return labels;
}

export interface NameWindow {
  lines: Line[];
  t0: number;
  t1: number;
  /** Survivor ids that speak in the window, in id order. */
  present: string[];
  /** The present ones still without a name at or above the floor. */
  candidates: string[];
}

export interface NameWindowConfig {
  name_window_s: number;
  name_floor: number;
}

const byId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/** The last name_window_s of lines with labels resolved to survivors. Null when there are no lines or nobody in them needs a name. */
export function selectNameWindow(lines: Line[], speakers: Speaker[], cfg: NameWindowConfig): NameWindow | null {
  const last = lines.at(-1);
  if (!last) return null;
  const recent = lines
    .filter((l) => l.t1 > last.t1 - cfg.name_window_s)
    .map((l) => (l.speaker_id === null ? l : { ...l, speaker_id: resolveId(speakers, l.speaker_id) }));
  const present = [...new Set(recent.flatMap((l) => (l.speaker_id === null ? [] : [l.speaker_id])))].sort(byId);
  const rows = new Map(speakers.map((s) => [s.speaker_id, s]));
  const candidates = present.filter((id) => {
    const row = rows.get(id);
    return !row?.name || (row.name_confidence ?? 0) < cfg.name_floor;
  });
  if (candidates.length === 0) return null;
  return { lines: recent, t0: recent[0]!.t0, t1: last.t1, present, candidates };
}

/** The user message: the sections agents/prompts/name names, in this order. `scheduled` lists who the schedule expects, the current talk's speakers first. */
export function renderNameWindow(window: NameWindow, speakers: Speaker[], scheduled: string[] = []): string {
  const rows = new Map(speakers.map((s) => [s.speaker_id, s]));
  const roster = window.present.map((id) => {
    const row = rows.get(id);
    if (!row?.name) return `${id}: (unnamed)`;
    const role = row.role ? `, ${row.role}` : "";
    return `${id}: ${row.name}${role} (confidence ${(row.name_confidence ?? 0).toFixed(2)})`;
  });
  const expected = scheduled.length > 0 ? `## scheduled speakers\n${scheduled.join("\n")}\n\n` : "";
  return `${expected}## speakers\n${roster.join("\n")}\n\n## transcript\n${window.lines.map((l) => renderLine(l)).join("\n")}`;
}

export interface Proposal {
  speaker_id: string;
  name: string;
  role: string | null;
  confidence: number;
  quote: string;
}

export interface Judged {
  speakerId: string;
  name: string;
  role: string | null;
  confidence: number;
  quote: string;
  quoteVerified: boolean;
  status: ProposalStatus;
  reason: string | null;
}

// Whole words of 2+ characters, so an initial or "Al" inside "also" cannot stand in for a name.
const words = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2);

/** A word of the name is in the quote, through the one or two wrong letters speech recognition gives a surname. */
function mentionsName(quote: string, name: string): boolean {
  const said = words(quote);
  return words(name).some((w) => said.some((q) => sameWord(w, q)));
}

/**
 * The evidence check for names. The quote may sit on anyone's line, since a host introduces a guest, but it must be in the
 * window word for word, the named speaker must speak there, the model must be sure enough, the quote must say the name, and a name already held must be weaker.
 */
export function judgeProposals(proposals: Proposal[], window: NameWindow, speakers: Speaker[], floor: number): Judged[] {
  const held = new Map(speakers.map((s) => [s.speaker_id, s.name === null ? null : (s.name_confidence ?? 0)]));
  return proposals.map((p) => {
    const quoteVerified = locateQuote(window.lines, p.quote) !== null;
    const base = { speakerId: p.speaker_id, name: p.name, role: p.role, confidence: p.confidence, quote: p.quote, quoteVerified };
    const reject = (reason: string): Judged => ({ ...base, status: "rejected", reason });
    if (!window.present.includes(p.speaker_id)) return reject(`${p.speaker_id} does not speak in the window`);
    if (!quoteVerified) return reject("quote not in the window");
    if (p.confidence < floor) return reject(`confidence ${p.confidence.toFixed(2)} is below the floor ${floor.toFixed(2)}`);
    if (!mentionsName(p.quote, p.name)) return reject("quote does not contain the name");
    const current = held.get(p.speaker_id) ?? null;
    if (current !== null && current >= p.confidence) return reject(`${p.speaker_id} already has a name at ${current.toFixed(2)}`);
    held.set(p.speaker_id, p.confidence);
    return { ...base, status: "accepted", reason: null };
  });
}
