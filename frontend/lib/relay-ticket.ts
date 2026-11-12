/**
 * The ticket a browser shows the live relay (relay/ on the VPS) to read one video's stream, minted here after the
 * password check: "<expS>.<hex HMAC-SHA256(RELAY_SECRET, sessionId.expS)>". relay/src/ticket.ts verifies it; both
 * test files pin the same vector. Web Crypto only, as lib/access.ts. RELAY_SECRET has no NEXT_PUBLIC_ prefix, so it
 * never reaches the browser; only the video page's server component calls relayFor.
 */
export const TICKET_TTL_S = 12 * 60 * 60;

export async function relayTicket(sessionId: string, secret: string, expS: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${sessionId}.${expS}`));
  return `${expS}.${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface Relay {
  url: string;
  ticket: string;
}

/** Null when the relay is not configured: the page then streams through its own route, as before the relay. */
export async function relayFor(sessionId: string): Promise<Relay | null> {
  const url = process.env.RELAY_URL?.replace(/\/+$/, "");
  const secret = process.env.RELAY_SECRET;
  if (!url || !secret) return null;
  return { url, ticket: await relayTicket(sessionId, secret, Math.floor(Date.now() / 1000) + TICKET_TTL_S) };
}
