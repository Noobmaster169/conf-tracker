import { FEED_CACHE_S, getFeed, SETTLED_CACHE_S } from "@/lib/api-client";
import { cleanFeedQuery } from "@/lib/api/guard";
import { BackendError } from "@/lib/api/transport";

/**
 * The Monitor page's poll and its "older" pages; the query passes through unchanged and the backend validates it.
 * Shared for a few seconds, so every open Monitor costs the box one call per window, not one each. The query is
 * cleaned first (cleanFeedQuery), so junk keys cannot make each request a new cache entry and a trip to the box. An older
 * page (`before`) is what was already said, so it is kept far longer; only the newest page and the poll stay short.
 */
export async function GET(request: Request) {
  const query = cleanFeedQuery(new URL(request.url).searchParams);
  if (query === null) return Response.json({ error: "bad feed query" }, { status: 400 });
  try {
    const older = new URLSearchParams(query).has("before");
    return Response.json(await getFeed(query, older ? SETTLED_CACHE_S : FEED_CACHE_S));
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
