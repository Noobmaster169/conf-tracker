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

/** Every version of a step's prompt on disk, newest first. */
export function listVersions(step: string, dir = PROMPTS_DIR): string[] {
  let files: string[];
  try {
    files = readdirSync(join(dir, step)).filter((name) => /^v\d+\.md$/.test(name));
  } catch (error) {
    throw new TerminalError(`no prompts for step "${step}"`, { cause: error });
  }
  if (files.length === 0) throw new TerminalError(`no prompts for step "${step}"`);
  return files.map((name) => name.slice(0, -3)).sort((a, b) => versionNumber(b) - versionNumber(a));
}

export function latestVersion(step: string, dir = PROMPTS_DIR): string {
  return listVersions(step, dir)[0]!;
}

export function loadPrompt(step: string, version: string, dir = PROMPTS_DIR): Prompt {
  if (!/^v\d+$/.test(version)) throw new TerminalError(`"${version}" is not a prompt version`);
  const path = join(dir, step, `${version}.md`);
  if (!existsSync(path)) throw new TerminalError(`no prompt ${step}/${version}`);
  const prompt = parsePromptFile(path);
  if (prompt.step !== step) throw new TerminalError(`${step}/${version} says it is for step "${prompt.step}"`);
  if (prompt.version !== version) throw new TerminalError(`${step}/${version}.md says it is version "${prompt.version}"`);
  return prompt;
}
