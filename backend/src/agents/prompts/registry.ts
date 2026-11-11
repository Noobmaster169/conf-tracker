import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { TerminalError } from "../../lib/errors";

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

const Frontmatter = z.object({
  step: z.string().min(1),
  version: z.string().regex(/^v\d+$/),
  /** A proxy alias. The session config may name another. */
  model: z.string().min(1),
  /** Only for a step with a reason to cap its answer. */
  max_tokens: z.coerce.number().int().positive().optional(),
});

export interface Prompt {
  step: string;
  version: string;
  model: string;
  maxTokens?: number;
  /** The system text, with `{{schema}}` still in place. */
  text: string;
}

/** The file is `---`, `key: value` lines, `---`, then the prompt. Nothing here needs more YAML than that. */
function parsePromptFile(path: string): Prompt {
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new TerminalError(`${path} has no frontmatter`);
  const fields = Object.fromEntries(
    match[1]!
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]),
  );
  const parsed = Frontmatter.safeParse(fields);
  if (!parsed.success) throw new TerminalError(`${path} has bad frontmatter: ${parsed.error.issues[0]?.message}`, { cause: parsed.error });
  const { step, version, model, max_tokens: maxTokens } = parsed.data;
  return maxTokens === undefined ? { step, version, model, text: match[2]!.trim() } : { step, version, model, maxTokens, text: match[2]!.trim() };
}

const versionNumber = (version: string): number => Number(version.slice(1));

/**
 * Prompt versions registered through the api (PUT /ops/prompts/:step/:version), kept in the database and mirrored here
 * so the loops can read them without a query. One of these is read before the file of the same step and version, and a
 * version that exists only here is as real as one on disk. They apply to the shipped prompts directory only.
 */
const overrides = new Map<string, Prompt>();

export function setOverrides(prompts: Prompt[]): void {
  overrides.clear();
  for (const prompt of prompts) overrides.set(`${prompt.step}/${prompt.version}`, prompt);
}

export function overrideFor(step: string, version: string): Prompt | null {
  return overrides.get(`${step}/${version}`) ?? null;
}

/** Every version of a step's prompt, on disk or registered through the api, newest first. */
export function listVersions(step: string, dir = PROMPTS_DIR): string[] {
  let files: string[];
  try {
    files = readdirSync(join(dir, step)).filter((name) => /^v\d+\.md$/.test(name));
  } catch (error) {
    throw new TerminalError(`no prompts for step "${step}"`, { cause: error });
  }
  if (files.length === 0) throw new TerminalError(`no prompts for step "${step}"`);
  const versions = new Set(files.map((name) => name.slice(0, -3)));
  if (dir === PROMPTS_DIR) for (const prompt of overrides.values()) if (prompt.step === step) versions.add(prompt.version);
  return [...versions].sort((a, b) => versionNumber(b) - versionNumber(a));
}

/** The steps that have prompts on disk. A registered version must belong to one of them. */
export function listSteps(dir = PROMPTS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("_")).map((entry) => entry.name).sort();
}

/** The file's own prompt, whatever is registered over it; null when the version is not on disk. */
export function shippedPrompt(step: string, version: string, dir = PROMPTS_DIR): Prompt | null {
  const path = join(dir, step, `${version}.md`);
  return /^v\d+$/.test(version) && existsSync(path) ? parsePromptFile(path) : null;
}

export function latestVersion(step: string, dir = PROMPTS_DIR): string {
  return listVersions(step, dir)[0]!;
}

export function loadPrompt(step: string, version: string, dir = PROMPTS_DIR): Prompt {
  if (!/^v\d+$/.test(version)) throw new TerminalError(`"${version}" is not a prompt version`);
  const registered = dir === PROMPTS_DIR ? overrideFor(step, version) : null;
  if (registered) return registered;
  const path = join(dir, step, `${version}.md`);
  if (!existsSync(path)) throw new TerminalError(`no prompt ${step}/${version}`);
  const prompt = parsePromptFile(path);
  if (prompt.step !== step) throw new TerminalError(`${step}/${version} says it is for step "${prompt.step}"`);
  if (prompt.version !== version) throw new TerminalError(`${step}/${version}.md says it is version "${prompt.version}"`);
  return prompt;
}
