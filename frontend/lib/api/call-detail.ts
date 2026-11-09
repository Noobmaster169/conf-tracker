/** Browser side: reads the app's own route, never the backend, so it stays clear of the server-only transport. */
import { CallDetail } from "./schemas";

export async function fetchCallDetail(id: number, signal: AbortSignal): Promise<CallDetail> {
  const response = await fetch(`/api/calls/${id}`, { signal, cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    throw new Error(typeof message === "string" ? message : `The call detail answered ${response.status}.`);
  }
  const parsed = CallDetail.safeParse(body);
  if (!parsed.success) throw new Error("The call detail answered outside the contract.");
  return parsed.data;
}
