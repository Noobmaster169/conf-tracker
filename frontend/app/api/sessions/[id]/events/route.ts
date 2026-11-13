import { streamEvents } from "@/lib/api-client";
import { isUuid } from "@/lib/api/guard";

/** The backend's stream handed straight to the browser, body unread. Last-Event-ID from a reconnect is forwarded as ?after. */
export const maxDuration = 300;

export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/events">) {
  const { id } = await ctx.params;
  // A video id is a uuid; anything else is answered here instead of opening a stream through the tunnel.
  if (!isUuid(id)) return Response.json({ error: "no such video" }, { status: 404 });
  const afterRaw = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
  // Number("") is 0, so only a plain non-negative integer counts as a resume point.
  const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : null;
  let upstream: Response;
  try {
    upstream = await streamEvents(id, after, request.signal);
  } catch {
    return Response.json({ error: "The event stream is unavailable." }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: `The event stream answered ${upstream.status}.` }, { status: upstream.status === 404 ? 404 : 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
