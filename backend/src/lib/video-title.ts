import { z } from "zod";

import { childLogger } from "./logger";

const log = childLogger({ module: "video-title" });
const OEmbed = z.object({ title: z.string().min(1) });

/** The video's title from YouTube's oEmbed. Null on any failure: a title is never worth refusing a video for. */
export async function fetchVideoTitle(url: string): Promise<string | null> {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const parsed = OEmbed.safeParse(await response.json());
    return parsed.success ? parsed.data.title : null;
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.message : String(error) }, "no title for the video");
    return null;
  }
}
