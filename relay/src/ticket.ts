import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A ticket lets one browser read one video's stream until it expires: "<expS>.<hex HMAC-SHA256(secret, id.expS)>".
 * The Vercel page mints it after the password check (frontend/lib/relay-ticket.ts); the relay only verifies.
 */
export function signTicket(sessionId: string, secret: string, expS: number): string {
  return `${expS}.${createHmac("sha256", secret).update(`${sessionId}.${expS}`).digest("hex")}`;
}

export function verifyTicket(ticket: string, sessionId: string, secret: string, nowS: number): boolean {
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(ticket);
  if (!match) return false;
  const expS = Number(match[1]);
  if (expS < nowS) return false;
  const expected = Buffer.from(signTicket(sessionId, secret, expS).split(".")[1], "hex");
  return timingSafeEqual(Buffer.from(match[2], "hex"), expected);
}
