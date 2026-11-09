/** Browser side: reads the app's own route, never the backend, so it stays clear of the server-only transport. */
import { Topics } from "./schemas";

export async function fetchTopics(sessionId: string, range: { from: number; to: number }, signal: AbortSignal): Promise<Topics> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/topics?from=${range.from}&to=${range.to}`, { signal, cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    throw new Error(typeof message === "string" ? message : `The topics answered ${response.status}.`);
  }
  const parsed = Topics.safeParse(body);
  if (!parsed.success) throw new Error("The topics answered outside the contract.");
  return parsed.data;
}
