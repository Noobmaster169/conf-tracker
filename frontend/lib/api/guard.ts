import { z } from "zod";

import { ClaimKind } from "@/lib/api/schemas";

/**
 * The public routes answer anyone, and every request that misses Vercel's cache travels the ngrok tunnel to the box.
 * These checks turn away what the backend would refuse anyway before it leaves Vercel, and make equal questions
 * look equal, so a made-up query string cannot buy a fresh trip through the tunnel each time.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (id: string): boolean => UUID.test(id);
export const isPlainInt = (value: string): boolean => /^\d{1,15}$/.test(value);

const int = z.string().regex(/^\d{1,15}$/);

/** The feed's keys, as the backend's FeedQuery has them; anything else is dropped. */
const FeedParams = z
  .object({
    before: int,
    after: int,
    kind: ClaimKind,
    min_importance: z.string().regex(/^[1-5]$/),
    person: int,
    talk: int,
    session: z.string().regex(UUID),
    limit: z.string().regex(/^\d{1,3}$/),
  })
  .partial();

/** The feed query with unknown keys dropped and the rest in a fixed order, or null when a known key is malformed. */
export function cleanFeedQuery(search: URLSearchParams): string | null {
  const known = FeedParams.keyof().options;
  const picked = Object.fromEntries(known.flatMap((key) => (search.has(key) ? [[key, search.get(key)!]] : [])));
  const parsed = FeedParams.safeParse(picked);
  if (!parsed.success) return null;
  const out = new URLSearchParams();
  for (const key of known) {
    const value = parsed.data[key];
    if (value !== undefined) out.set(key, value);
  }
  return out.toString();
}
