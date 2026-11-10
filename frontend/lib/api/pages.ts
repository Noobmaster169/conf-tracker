import { z } from "zod";

import { Feed, PersonCard, PersonDetail, TalkCard, TalkDetail, VideoCard } from "./views";
import { BackendError, get, parseAs, refusalMessage, request } from "./transport";

/** What each page opens on. Read-only. */

/** `all` is for the admin area: it adds what belongs to hidden stages. */
export function listVideos(all = false): Promise<VideoCard[]> {
  return get(z.array(VideoCard), all ? "/videos?all=1" : "/videos");
}

/** GET /feed; the query string passes through and the backend validates it. */
export function getFeed(query = ""): Promise<Feed> {
  return get(Feed, query ? `/feed?${query}` : "/feed");
}

export function listPeople(all = false): Promise<PersonCard[]> {
  return get(z.array(PersonCard), all ? "/people?all=1" : "/people");
}

export function listTalks(): Promise<TalkCard[]> {
  return get(z.array(TalkCard), "/talks");
}

async function orNull<T>(schema: z.ZodType<T>, path: string): Promise<T | null> {
  const response = await request(path);
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
