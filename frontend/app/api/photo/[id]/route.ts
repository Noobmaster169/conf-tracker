import { request } from "@/lib/api/transport";

/** A person's stored photo, passed through from the backend. The link carries a version, so browsers keep it. */
export async function GET(_request: Request, { params }: RouteContext<"/api/photo/[id]">) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return new Response(null, { status: 404 });
  try {
    const upstream = await request(`/people/${id}/photo`);
    if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") ?? "image/jpeg", "cache-control": "private, max-age=31536000, immutable" },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
