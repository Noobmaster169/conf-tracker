import { searchClaims } from "@/lib/api/sessions";
import { BackendError } from "@/lib/api/transport";

/** A further page of the claims explorer; the query passes through unchanged and the backend validates it. */
export async function GET(request: Request) {
  try {
    return Response.json(await searchClaims(new URL(request.url).searchParams.toString()));
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 502;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
