/** Browser side: reads the app's own route, never the backend, so it stays clear of the server-only transport. */
import { SpeakerDetail } from "./schemas";

export async function fetchSpeakerDetail(sessionId: string, speakerId: string, signal: AbortSignal): Promise<SpeakerDetail> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/speakers/${encodeURIComponent(speakerId)}`, { signal, cache: "no-store" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    throw new Error(typeof message === "string" ? message : `The speaker detail answered ${response.status}.`);
  }
  const parsed = SpeakerDetail.safeParse(body);
  if (!parsed.success) throw new Error("The speaker detail answered outside the contract.");
  return parsed.data;
}
