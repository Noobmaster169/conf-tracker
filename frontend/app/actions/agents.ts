"use server";

import { cookies } from "next/headers";

import { ACCESS_COOKIE, hasAccess } from "@/lib/access";
import { run, text } from "@/lib/admin-action";
import { changedSettings, nextVersion, settingsDone } from "@/lib/agent-forms";
import * as api from "@/lib/api-client";

/** The Agents pages' forms. Built like every other admin action: back to the page, with what happened. */

export async function resolveIncidentAction(form: FormData): Promise<void> {
  await run(form, "/admin/agents", "Marked resolved. It will not be raised again while it lasts.", async () => {
    await api.resolveIncident(Number(text(form, "id")));
  });
}

const APPLY = new Set(["all", "new", "running"]);

/** Saves the text as the next version, never over an existing one, and puts it in use where asked. */
export async function saveInstructionsAction(form: FormData): Promise<void> {
  const id = text(form, "agent");
  let done = "";
  await run(form, `/admin/agents/${id}`, () => done, async () => {
    const agent = await api.getAgent(id);
    if (!agent) throw new Error("No such agent");
    const body = String(form.get("text") ?? "");
    if (!body.trim()) throw new Error("The instructions are empty");
    const version = nextVersion(agent.instructions);
    await api.putPrompt(agent.id, version, { text: body, ...(agent.model ? { model: agent.model } : {}) });
    const apply = text(form, "apply");
    if (!APPLY.has(apply) || !agent.prompt_key) {
      done = `Saved as ${version}. It is not in use yet.`;
      return;
    }
    const result = await api.patchSettings(agent.id, { [agent.prompt_key]: version }, apply as api.Apply);
    done = `Saved as ${version}. ${settingsDone(result)}`;
  });
}

/** Saves the settings that were changed in the form, where asked. */
export async function saveSettingsAction(form: FormData): Promise<void> {
  const id = text(form, "agent");
  let done = "";
  await run(form, `/admin/agents/${id}`, () => done, async () => {
    const agent = await api.getAgent(id);
    if (!agent) throw new Error("No such agent");
    const set = changedSettings(agent.settings, (key) => (form.has(`s:${key}`) ? String(form.get(`s:${key}`)) : null));
    if (Object.keys(set).length === 0) {
      done = "Nothing changed.";
      return;
    }
    const apply = text(form, "apply");
    done = settingsDone(await api.patchSettings(agent.id, set, APPLY.has(apply) ? (apply as api.Apply) : "all"));
  });
}

/**
 * Starts a rerun and answers with it, for the call window to follow. Called from the page's own code, not posted as a
 * form, so it answers instead of sending the reader anywhere; it proves the password itself like every admin action.
 */
export async function startRerunAction(callId: number, version: string, model: string): Promise<{ rerun: api.Rerun } | { error: string }> {
  if (!(await hasAccess((await cookies()).get(ACCESS_COOKIE)?.value, process.env.ACCESS_PASSWORD))) return { error: "Sign in to the admin area first." };
  try {
    return { rerun: await api.startRerun(callId, { prompt_version: version, model }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "That did not work" };
  }
}
