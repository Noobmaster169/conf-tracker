import { getFeed } from "@/lib/api-client";
import { BackendError } from "@/lib/api/transport";

/** The Monitor page's poll and its "older" pages; the query passes through unchanged and the backend validates it. */
export async function GET(request: Request) {
  try {
    return Response.json(await getFeed(new URL(request.url).searchParams.toString()));
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
