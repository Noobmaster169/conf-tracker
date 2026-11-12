import type { AgentInstructions, AgentSetting, SettingsResult } from "./api/agent-schemas";

/** The pure parts of the Agents pages' forms, apart from the actions so they can be tested. */

/** The number after the highest version there is: "v6" after v3, v5. "v1" when there is none. */
export function nextVersion(instructions: Pick<AgentInstructions, "version">[]): string {
  const highest = Math.max(0, ...instructions.map((i) => Number(/^v(\d+)$/.exec(i.version)?.[1] ?? 0)));
  return `v${highest + 1}`;
}

export type FieldKind = "boolean" | "number" | "text" | "json";

/** How a setting is edited, from what its default is. */
export function fieldKind(setting: Pick<AgentSetting, "default">): FieldKind {
  const kind = typeof setting.default;
  return kind === "boolean" ? "boolean" : kind === "number" ? "number" : kind === "string" ? "text" : "json";
}

/** A setting's value as a form field shows it. */
export function fieldText(value: unknown): string {
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

/**
 * What a posted settings form asks to change: only the keys whose value differs from what is stored now. A field
 * left empty takes the key back to its default (null). Throws, naming the field, when a value cannot be read.
 */
export function changedSettings(settings: AgentSetting[], read: (key: string) => string | null): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const setting of settings) {
    const kind = fieldKind(setting);
    const raw = read(setting.key);
    let next: unknown;
    if (kind === "boolean") next = raw === "on";
    else if (raw === null) continue;
    else if (raw.trim() === "") next = null;
    else if (kind === "number") {
      next = Number(raw);
      if (!Number.isFinite(next)) throw new Error(`${setting.key}: "${raw}" is not a number`);
    } else if (kind === "json") {
      try {
        next = JSON.parse(raw);
      } catch {
        throw new Error(`${setting.key}: not valid JSON`);
      }
    } else next = raw.trim();
    const now = next === null ? setting.default : next;
    if (JSON.stringify(now) !== JSON.stringify(setting.value)) set[setting.key] = next;
  }
  return set;
}

/** What a settings change did, as one sentence for the notice. */
export function settingsDone(result: SettingsResult): string {
  const videos = result.sessions.length;
  const where = [result.default_changed ? "new videos" : null, videos > 0 ? `${videos} running video${videos === 1 ? "" : "s"}` : null].filter(Boolean);
  if (where.length === 0) return "Nothing changed: those are the values already in use.";
  const waits = result.waits_for_next_start.length > 0 ? ` ${result.waits_for_next_start.join(", ")} waits for a video's next start.` : "";
  return `Saved for ${where.join(" and ")}.${waits}`;
}
