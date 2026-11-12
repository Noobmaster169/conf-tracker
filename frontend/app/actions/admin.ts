"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE, hasAccess } from "@/lib/access";

import * as api from "@/lib/api-client";
import { parseSpeakers } from "@/lib/speakers-text";

/**
 * Every admin form posts here. An action that fails sends the reader back to the page they were on with the reason
 * in `?error=`, and one that works with what happened in `?done=`, so nothing is ever silently lost.
 */

const text = (form: FormData, key: string): string => String(form.get(key) ?? "").trim();
const orNull = (form: FormData, key: string): string | null => text(form, key) || null;

function back(form: FormData, fallback: string): string {
  const path = text(form, "back");
  return path.startsWith("/admin") ? path : fallback;
}

/** The site is public, so every admin action proves the password itself: an action can be posted from any page. */
async function requireAdmin(form: FormData, fallback: string): Promise<void> {
  if (await hasAccess((await cookies()).get(ACCESS_COOKIE)?.value, process.env.ACCESS_PASSWORD)) return;
  redirect(`/login?next=${encodeURIComponent(back(form, fallback))}`);
}

async function run(form: FormData, fallback: string, done: string, work: () => Promise<string | void>): Promise<never> {
  await requireAdmin(form, fallback);
  let target = back(form, fallback);
  try {
    target = (await work()) ?? target;
  } catch (error) {
    redirect(`${back(form, fallback)}?error=${encodeURIComponent(error instanceof Error ? error.message : "That did not work")}`);
  }
  revalidatePath("/", "layout");
  redirect(`${target}?done=${encodeURIComponent(done)}`);
}

const stageInput = (form: FormData): api.StageInput => ({
  conference: text(form, "conference"),
  name: text(form, "name"),
  day: orNull(form, "day"),
  description: text(form, "description"),
  hidden: form.get("hidden") === "on",
});

const talkInput = (form: FormData): api.TalkInput => ({
  title: text(form, "title"),
  description: text(form, "description"),
  kind: text(form, "kind") || "talk",
  starts_at: orNull(form, "starts_at"),
  ends_at: orNull(form, "ends_at"),
  speakers: parseSpeakers(text(form, "speakers")),
});

export async function createStageAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Stage created. Add its schedule below.", async () => `/admin/stage/${(await api.createStage(stageInput(form))).id}`);
}

export async function updateStageAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Stage saved", async () => void (await api.updateStage(text(form, "id"), stageInput(form))));
}

export async function importScheduleAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Schedule added", async () => void (await api.importSchedule(text(form, "stage_id"), text(form, "text"))));
}

export async function createTalkAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Session added", async () => void (await api.createTalk(text(form, "stage_id"), talkInput(form))));
}

export async function updateTalkAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Session saved", async () => void (await api.updateTalk(Number(text(form, "id")), talkInput(form))));
}

export async function removeTalkAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Session removed from the schedule", () => api.removeTalk(Number(text(form, "id"))));
}

export async function writeSummaryAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Summary written", async () => void (await api.writeSummary(Number(text(form, "id")))));
}

export async function trackVideoAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Tracking started", async () => void (await api.createSession(text(form, "url"), orNull(form, "stage_id"))));
}

export async function stopVideoAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Tracking stopped", async () => void (await api.stopSession(text(form, "id"))));
}

export async function resumeVideoAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Tracking resumed", async () => void (await api.resumeSession(text(form, "id"))));
}

export async function setVideoStageAction(form: FormData): Promise<void> {
  await run(form, "/admin", "Video moved", async () => void (await api.setSessionStage(text(form, "id"), orNull(form, "stage_id"))));
}

export async function setNowAction(form: FormData): Promise<void> {
  const talk = text(form, "talk_id");
  await run(form, "/admin", "On-stage session corrected", async () => void (await api.setNowOnStage(text(form, "id"), talk === "break" ? null : Number(talk))));
}

export async function updatePersonAction(form: FormData): Promise<void> {
  await run(form, "/admin/speakers", "Speaker saved", async () => {
    await api.updatePerson(Number(text(form, "id")), { name: text(form, "name"), org: orNull(form, "org"), title: orNull(form, "title"), photo_url: orNull(form, "photo_url") ?? orNull(form, "photo_stored") });
  });
}

export async function removePersonAction(form: FormData): Promise<void> {
  await run(form, "/admin/speakers", "Speaker removed", () => api.removePerson(Number(text(form, "id"))));
}
