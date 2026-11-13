import { PAGE_CACHE_S, request } from "@/lib/api/transport";
import { photoCacheControl } from "@/lib/photo";

/** A person's stored photo, passed through from the backend. */
export async function GET(incoming: Request, { params }: RouteContext<"/api/photo/[id]">) {
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) return new Response(null, { status: 404 });
  const version = new URL(incoming.url).searchParams.get("v");
  if (version !== null && !/^\d{1,15}$/.test(version)) return new Response(null, { status: 404 });
  try {
    // Shared in Vercel's data cache by person (keyed on the backend path, not the ?v), so a made-up ?v= misses only
    // the edge cache, not this one. An admin write clears it with the other public reads (PUBLIC_TAG).
    const upstream = await request(`/people/${id}/photo`, { shared: PAGE_CACHE_S * 20 });
    if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    return new Response(upstream.body, {
      headers: { "content-type": upstream.headers.get("content-type") ?? "image/jpeg", "cache-control": photoCacheControl(incoming.url) },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
