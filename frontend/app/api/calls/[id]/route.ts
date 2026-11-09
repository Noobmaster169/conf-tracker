import { getCall } from "@/lib/api/sessions";
import { BackendError } from "@/lib/api/transport";

/** One model call in full, for the audit drawer. */
export async function GET(_request: Request, ctx: RouteContext<"/api/calls/[id]">) {
  const { id } = await ctx.params;
  const callId = Number(id);
  if (!Number.isInteger(callId) || callId <= 0) return Response.json({ error: "Call not found." }, { status: 404 });
  try {
    const detail = await getCall(callId);
    if (!detail) return Response.json({ error: "Call not found." }, { status: 404 });
    return Response.json(detail);
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
