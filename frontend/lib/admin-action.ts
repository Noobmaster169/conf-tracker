import "server-only";

import { revalidatePath, updateTag } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_COOKIE, hasAccess } from "@/lib/access";
import { PUBLIC_TAG } from "@/lib/api/transport";

/**
 * What every admin form action is built on. An action that fails sends the reader back to the page they were on with
 * the reason in `error`, and one that works with what happened in `done`, so nothing is ever silently lost.
 * Not a "use server" file: these are helpers, never actions a browser can call.
 */

export const text = (form: FormData, key: string): string => String(form.get(key) ?? "").trim();
export const orNull = (form: FormData, key: string): string | null => text(form, key) || null;

export function back(form: FormData, fallback: string): string {
  const path = text(form, "back");
  return path.startsWith("/admin") ? path : fallback;
}

/** A path with one more query parameter, whether or not it already has some. Any `#part` stays last. */
export function withParam(path: string, key: string, value: string): string {
  const [rest = "", hash] = path.split("#");
  const [base = "", query = ""] = rest.split("?");
  const params = new URLSearchParams(query);
  params.delete("error");
  params.delete("done");
  params.set(key, value);
  return `${base}?${params}${hash ? `#${hash}` : ""}`;
}

/** The site is public, so every admin action proves the password itself: an action can be posted from any page. */
export async function requireAdmin(form: FormData, fallback: string): Promise<void> {
  if (await hasAccess((await cookies()).get(ACCESS_COOKIE)?.value, process.env.ACCESS_PASSWORD)) return;
  redirect(`/login?next=${encodeURIComponent(back(form, fallback))}`);
}

export async function run(form: FormData, fallback: string, done: string | (() => string), work: () => Promise<string | void>): Promise<never> {
  await requireAdmin(form, fallback);
  let target = back(form, fallback);
  try {
    target = (await work()) ?? target;
  } catch (error) {
    redirect(withParam(back(form, fallback), "error", error instanceof Error ? error.message : "That did not work"));
  }
  // The public pages share their data for a few seconds; a change made here shows on the next load, not after it.
  updateTag(PUBLIC_TAG);
  revalidatePath("/", "layout");
  redirect(withParam(target, "done", typeof done === "function" ? done() : done));
}
