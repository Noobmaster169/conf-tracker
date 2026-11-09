"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { createSession, replaySession, stopSession } from "@/lib/api-client";

export async function startSession(formData: FormData): Promise<void> {
  const url = formData.get("url");
  if (typeof url !== "string" || url.trim() === "") redirect(`/?error=${encodeURIComponent("Paste a YouTube URL")}`);
  let id: string;
  try {
    id = (await createSession(url.trim())).id;
  } catch (error) {
    redirect(`/?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not start the session")}`);
  }
  redirect(`/session/${id}`);
}

export async function stopSessionAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  if (typeof id !== "string") return;
  try {
    await stopSession(id);
  } catch (error) {
    redirect(`/session/${id}?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not stop the session")}`);
  }
  revalidatePath(`/session/${id}`);
}

export interface ReplayState {
  error: string | null;
}

/** Starts a replay and opens it; a refusal comes back to the form instead of leaving the page. */
export async function replaySessionAction(_prev: ReplayState, formData: FormData): Promise<ReplayState> {
  const id = formData.get("id");
  const speed = Number(formData.get("speed"));
  const raw = formData.get("config");
  if (typeof id !== "string" || typeof raw !== "string" || !Number.isFinite(speed)) return { error: "Incomplete form" };
  let config: unknown;
  let original: unknown;
  try {
    config = raw.trim() === "" ? {} : JSON.parse(raw);
    original = JSON.parse(String(formData.get("original") ?? "{}"));
  } catch {
    return { error: "Config is not valid JSON" };
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return { error: "Config must be a JSON object" };
  if (typeof original !== "object" || original === null) return { error: "Incomplete form" };
  // The box starts as the original's config, so a key deleted from it goes back to its default (null removes it).
  const overrides: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const key of Object.keys(original)) if (!(key in overrides)) overrides[key] = null;
  let replay: string;
  try {
    replay = (await replaySession(id, { config: overrides, speed })).id;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not start the replay" };
  }
  redirect(`/session/${replay}`);
}
