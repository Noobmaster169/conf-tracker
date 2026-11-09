// Reaches YouTube from the server; nothing in the browser needs it.
import "server-only";

import { z } from "zod";

export interface VideoTitle {
  title: string;
  author: string;
}

const OEmbed = z.object({ title: z.string(), author_name: z.string() });

/** Next caches only good responses, so a failed id is remembered here, or a blocked YouTube would cost every render 3 s. */
const FAILED_FOR_MS = 10 * 60_000;
const failedAt = new Map<string, number>();

/** The video's title and channel from YouTube's oEmbed, cached a day. Null on any failure: a title is never worth failing a page. */
async function videoTitle(id: string): Promise<VideoTitle | null> {
  const failed = failedAt.get(id);
  if (failed !== undefined && Date.now() - failed < FAILED_FOR_MS) return null;
  const title = await lookup(id);
  if (title) failedAt.delete(id);
  else failedAt.set(id, Date.now());
  return title;
}

async function lookup(id: string): Promise<VideoTitle | null> {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
    const response = await fetch(url, { next: { revalidate: 86_400 }, signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const parsed = OEmbed.safeParse(await response.json());
    return parsed.success ? { title: parsed.data.title, author: parsed.data.author_name } : null;
  } catch {
    return null;
  }
}

export async function videoTitles(ids: (string | null)[]): Promise<Record<string, VideoTitle>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const found = await Promise.all(unique.map(async (id) => [id, await videoTitle(id)] as const));
  return Object.fromEntries(found.filter((entry): entry is readonly [string, VideoTitle] => entry[1] !== null));
}
