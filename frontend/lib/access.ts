/**
 * The password gate. The cookie holds an HMAC of a fixed label keyed by ACCESS_PASSWORD,
 * so it cannot be forged without the password and every cookie dies when the password changes.
 * Web Crypto only: proxy.ts imports this too.
 */
export const ACCESS_COOKIE = "yt_access";
export const ACCESS_MAX_AGE_S = 60 * 60 * 24 * 30;

export async function accessToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("conf-tracker-access-v1"));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent of where the first difference is, so the comparison leaks nothing by timing. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Unset password means no one gets in: the gate fails closed. */
export async function hasAccess(cookie: string | undefined, password: string | undefined): Promise<boolean> {
  if (!password || !cookie) return false;
  return safeEqual(cookie, await accessToken(password));
}

/** Only same-site paths survive as a post-login destination. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
