import { isFrameUrl } from "@/lib/frames";

/**
 * A frame image handed over as a file, for the viewer's Download and Share. The image lives on R2, another origin, where
 * a browser ignores `download` and a page cannot read the bytes to share them; this passes the same bytes on from here.
 * Only frame images on R2 (isFrameUrl): never an open proxy. A frame's key never changes, so it is cached for good.
 */
export async function GET(incoming: Request) {
  const params = new URL(incoming.url).searchParams;
  const url = params.get("u") ?? "";
  if (!isFrameUrl(url)) return new Response(null, { status: 404 });
  const name = (params.get("name") ?? "frame.webp").replace(/[^\w.-]/g, "").slice(0, 100) || "frame.webp";
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
    return new Response(upstream.body, {
      headers: {
        "content-type": "image/webp",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
