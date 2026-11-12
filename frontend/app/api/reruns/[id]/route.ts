import { cookies } from "next/headers";

import { ACCESS_COOKIE, hasAccess } from "@/lib/access";
import { getRerun } from "@/lib/api-client";

/** How a rerun is getting on, for the call window to poll. Admin only: it carries a model's answer about a call. */
export async function GET(_request: Request, { params }: RouteContext<"/api/reruns/[id]">) {
  if (!(await hasAccess((await cookies()).get(ACCESS_COOKIE)?.value, process.env.ACCESS_PASSWORD))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "no such rerun" }, { status: 404 });
  try {
    const rerun = await getRerun(Number(id));
    return rerun ? Response.json(rerun, { headers: { "cache-control": "no-store" } }) : Response.json({ error: "no such rerun" }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "the api did not answer" }, { status: 502 });
  }
}
