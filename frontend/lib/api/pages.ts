import { z } from "zod";

import type { Person } from "./conference";
import { pageByT0 } from "./paging";
import { Segment, Snapshot, type Speaker } from "./schemas";
import { Feed, Frame, PersonCard, PersonDetail, TalkCard, TalkDetail, VideoCard } from "./views";
import { BackendError, get, PAGE_CACHE_S, parseAs, refusalMessage, request } from "./transport";

export { FEED_CACHE_S, SETTLED_CACHE_S } from "./transport";

/** What each page opens on. Read-only. The public ones are shared between visitors for a few seconds (transport.ts). */

/** `all` is for the admin area: it adds what belongs to hidden stages. */
export function listVideos(all = false): Promise<VideoCard[]> {
  return all ? get(z.array(VideoCard), "/videos?all=1") : get(z.array(VideoCard), "/videos", PAGE_CACHE_S);
}

/**
 * GET /feed; the query string passes through and the backend validates it. `shared` is for the Monitor, whose tabs
 * all poll the same thing; a video page reads it fresh, beside its uncached snapshot.
 */
export function getFeed(query = "", shared?: number): Promise<Feed> {
  return get(Feed, query ? `/feed?${query}` : "/feed", shared);
}

export function listPeople(all = false): Promise<PersonCard[]> {
  return all ? get(z.array(PersonCard), "/people?all=1") : get(z.array(PersonCard), "/people", PAGE_CACHE_S);
}

export function listTalks(): Promise<TalkCard[]> {
  return get(z.array(TalkCard), "/talks", PAGE_CACHE_S);
}

async function orNull<T>(schema: z.ZodType<T>, path: string): Promise<T | null> {
  const response = await request(path, { shared: PAGE_CACHE_S });
  if (response.status === 404) return null;
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(schema, response, `GET ${path}`);
}

export function getPerson(id: string): Promise<PersonDetail | null> {
  return /^\d+$/.test(id) ? orNull(PersonDetail, `/people/${id}`) : Promise.resolve(null);
}

export function getTalk(id: string): Promise<TalkDetail | null> {
  return /^\d+$/.test(id) ? orNull(TalkDetail, `/talks/${id}`) : Promise.resolve(null);
}

/**
 * What a talk's video heard between `t0` and `t1` (null: still running), with the video's voices and people to name
 * them. Null when it cannot be read, so a transcript that fails does not take the session page with it.
 */
export async function getTalkTranscript(
  sessionId: string,
  t0: number,
  t1: number | null,
): Promise<{ segments: Segment[]; speakers: Speaker[]; people: Person[] } | null> {
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  try {
    const [segments, snapshot] = await Promise.all([
      pageByT0((from) => get(z.array(Segment), `${base}/transcript?from=${Math.max(from, t0)}${t1 === null ? "" : `&to=${t1}`}`, PAGE_CACHE_S)),
      get(Snapshot, base, PAGE_CACHE_S),
    ]);
    return { segments, speakers: snapshot.speakers, people: snapshot.people };
  } catch {
    return null;
  }
}

/**
 * A session's gallery, oldest first. Empty rather than an error: the dashboard ships before the api while a running video
 * holds the api's deploy back, and a gallery that cannot load must not take the session page with it.
 */
export async function getTalkFrames(id: string): Promise<Frame[]> {
  if (!/^\d+$/.test(id)) return [];
  try {
    return (await orNull(z.array(Frame), `/talks/${id}/frames`)) ?? [];
  } catch {
    return [];
  }
}
