/** Browser side: reads the app's own route, never the backend, so it stays clear of the server-only transport. */
import { ClaimSearch } from "./claim-schemas";

export async function fetchClaimPage(query: string, signal: AbortSignal): Promise<ClaimSearch> {
  const response = await fetch(`/api/claims?${query}`, { signal, cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    throw new Error(typeof message === "string" ? message : `The claims answered ${response.status}.`);
  }
  const parsed = ClaimSearch.safeParse(body);
  if (!parsed.success) throw new Error("The claims answered outside the contract.");
  return parsed.data;
}
