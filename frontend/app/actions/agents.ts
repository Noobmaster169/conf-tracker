"use server";

import { run, text } from "@/lib/admin-action";
import * as api from "@/lib/api-client";

/** The Agents pages' forms. Built like every other admin action: back to the page, with what happened. */

export async function resolveIncidentAction(form: FormData): Promise<void> {
  await run(form, "/admin/agents", "Marked resolved. It will not be raised again while it lasts.", async () => {
    await api.resolveIncident(Number(text(form, "id")));
  });
}
