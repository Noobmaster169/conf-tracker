import { getSpeaker } from "@/lib/api/sessions";
import { BackendError } from "@/lib/api/transport";

/** One speaker's registry row and recent window scores, for the panel's expanded row. */
export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[id]/speakers/[sid]">) {
  const { id, sid } = await ctx.params;
  try {
    const detail = await getSpeaker(id, sid);
    if (!detail) return Response.json({ error: "Speaker not found." }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
