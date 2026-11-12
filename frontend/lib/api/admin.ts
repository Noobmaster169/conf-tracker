import { z } from "zod";

import { Person, Stage, Talk, TalkPost, TalkSummary } from "./conference";
import { StageDetail, StageWithTalks } from "./views";
import { BackendError, get, parseAs, refusalMessage, request } from "./transport";

/** The admin area's reads and writes: stages, schedules, people. */

async function send<T>(schema: z.ZodType<T>, method: "POST" | "PUT", path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const response = await request(path, { method, body: JSON.stringify(body), timeoutMs });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(schema, response, `${method} ${path}`);
}

export function listStages(): Promise<StageWithTalks[]> {
  return get(z.array(StageWithTalks), "/stages");
}

export async function getStage(id: string): Promise<StageDetail | null> {
  const response = await request(`/stages/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
  return parseAs(StageDetail, response, "GET /stages/:id");
}

export interface StageInput {
  conference: string;
  name: string;
  day: string | null;
  description: string;
  hidden: boolean;
}

export function createStage(input: StageInput): Promise<Stage> {
  return send(Stage, "POST", "/stages", input);
}

export function updateStage(id: string, input: StageInput): Promise<Stage> {
  return send(Stage, "PUT", `/stages/${encodeURIComponent(id)}`, input);
}

export function importSchedule(stageId: string, text: string): Promise<Talk[]> {
  return send(z.array(Talk), "POST", `/stages/${encodeURIComponent(stageId)}/import`, { text });
}

export interface TalkInput {
  title: string;
  description: string;
  kind: string;
  starts_at: string | null;
  ends_at: string | null;
  speakers: { name: string; org: string | null; title: string | null; role: string }[];
}

export function createTalk(stageId: string, input: TalkInput): Promise<Talk> {
  return send(Talk, "POST", `/stages/${encodeURIComponent(stageId)}/talks`, input);
}

export function updateTalk(id: number, input: TalkInput): Promise<Talk> {
  return send(Talk, "PUT", `/talks/${id}`, input);
}

export async function removeTalk(id: number): Promise<void> {
  const response = await request(`/talks/${id}`, { method: "DELETE" });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
}

/** Answers once the summary is written, which takes the model up to a few minutes. */
export function writeSummary(talkId: number): Promise<TalkSummary> {
  return send(TalkSummary, "POST", `/talks/${talkId}/summary`, {}, 300_000);
}

/** Answers once the post is written from the talk's summary and claims, which takes the model up to a minute or two. */
export function writePost(talkId: number): Promise<TalkPost> {
  return send(TalkPost, "POST", `/talks/${talkId}/post`, {}, 300_000);
}

export interface PersonInput {
  name: string;
  org: string | null;
  title: string | null;
  photo_url: string | null;
}

export async function removePerson(id: number): Promise<void> {
  const response = await request(`/people/${id}`, { method: "DELETE" });
  if (!response.ok) throw new BackendError(await refusalMessage(response), response.status);
}

export function updatePerson(id: number, input: PersonInput): Promise<Person> {
  return send(Person, "PUT", `/people/${id}`, input);
}
