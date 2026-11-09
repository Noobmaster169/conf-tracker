import { getTopics } from "@/lib/api/sessions";
import { BackendError } from "@/lib/api/transport";

/** Topic counts for a stream-time range, for the topics panel. */
export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/topics">) {
  const { id } = await ctx.params;
  const query = new URL(request.url).searchParams;
  const from = Number(query.get("from") ?? 0);
  const to = Number(query.get("to") ?? 0);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Response.json({ error: "from and to must be numbers." }, { status: 400 });
  try {
    return Response.json(await getTopics(id, from, to));
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
