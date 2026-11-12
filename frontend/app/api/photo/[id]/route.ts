import { request } from "@/lib/api/transport";
import { photoCacheControl } from "@/lib/photo";

/** A person's stored photo, passed through from the backend. */
export async function GET(incoming: Request, { params }: RouteContext<"/api/photo/[id]">) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return new Response(null, { status: 404 });
  try {
    const upstream = await request(`/people/${id}/photo`);
    if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") ?? "image/jpeg", "cache-control": photoCacheControl(incoming.url) },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
