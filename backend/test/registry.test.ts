import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { latestVersion, listVersions, loadPrompt } from "../src/agents/prompts/registry";

test("the shipped extract prompt loads with its frontmatter and schema slot", () => {
  const prompt = loadPrompt("extract", "v3");
  expect(prompt).toMatchObject({ step: "extract", version: "v3", model: "sonnet" });
  expect(prompt.text).toContain("{{schema}}");
  expect(prompt.text).toContain('the section headed "new lines"');
  expect(listVersions("extract")).toContain("v3");
  expect(latestVersion("extract")).toMatch(/^v\d+$/);
});

test("versions sort numerically, and a bad file or version is a terminal error naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  mkdirSync(join(dir, "name"));
  writeFileSync(join(dir, "name", "v2.md"), "---\nstep: name\nversion: v2\nmodel: haiku\nmax_tokens: 400\n---\nSecond.");
  writeFileSync(join(dir, "name", "v10.md"), "---\nstep: name\nversion: v10\nmodel: haiku\n---\nTenth.");
  writeFileSync(join(dir, "name", "v3.md"), "---\nstep: extract\nversion: v3\nmodel: haiku\n---\nWrong step.");
  writeFileSync(join(dir, "name", "notes.md"), "not a prompt");
  expect(listVersions("name", dir)).toEqual(["v10", "v3", "v2"]);
  expect(latestVersion("name", dir)).toBe("v10");
  expect(loadPrompt("name", "v2", dir)).toEqual({ step: "name", version: "v2", model: "haiku", maxTokens: 400, text: "Second." });
  expect(() => loadPrompt("name", "v3", dir)).toThrow(/says it is for step "extract"/);
  expect(() => loadPrompt("name", "v9", dir)).toThrow(/no prompt name\/v9/);
  expect(() => loadPrompt("name", "latest", dir)).toThrow(/not a prompt version/);
  expect(() => listVersions("missing", dir)).toThrow(/no prompts for step "missing"/);
});

test("extract v5 is the newest extract prompt; v4 and v3 stay loadable and all are about conference talks", () => {
  expect(listVersions("extract")).toEqual(["v5", "v4", "v3"]);
  expect(latestVersion("extract")).toBe("v5");
  expect(loadPrompt("extract", "v5").text).toContain("Do not name the speaker");
  expect(loadPrompt("extract", "v5").text).toContain("{{schema}}");
  expect(loadPrompt("extract", "v4").text).toContain("on stage");
  const prompt = loadPrompt("extract", "v3");
  expect(prompt).toMatchObject({ step: "extract", version: "v3", model: "sonnet" });
  expect(prompt.text).toContain("{{schema}}");
  expect(prompt.text).toContain("[mm:ss S3 Jane Doe]");
  expect(prompt.text.toLowerCase()).toContain("conference");
  expect(() => loadPrompt("extract", "v2")).toThrow();
});
