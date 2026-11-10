import { ClaimKind } from "../contracts";
import { type Feed, FeedItem, type FeedQuery } from "../contracts-views";
import type { Queryable } from "../db";
import { videoIdFromUrl } from "../lib/youtube-id";
import * as claimRepo from "./claims";

/** Every diarized label resolved to the survivor of its merges (depth-capped, so a cycle cannot loop). */
export const SURVIVOR_CTE = `
chain as (
  select session_id, speaker_id as raw_id, speaker_id as cur, merged_into, 0 as depth from speakers
  union all
  select c.session_id, c.raw_id, s.speaker_id, s.merged_into, c.depth + 1
  from chain c join speakers s on s.session_id = c.session_id and s.speaker_id = c.merged_into
  where c.depth < 20
),
survivor as (select session_id, raw_id, cur from chain where merged_into is null)`;

/** The talk on stage when a claim was said: the span of its video that covers the claim's time. */
export const TALK_AT = `
  left join lateral (
    select k.talk_id from talk_spans k
    where k.session_id = c.session_id and k.state = 'talk' and c.t0 >= k.t0 and (k.t1 is null or c.t0 < k.t1)
    order by k.t0 desc, k.id desc limit 1
  ) k on true`;

/**
 * Claims as a reader meets them: verified, not a repeat, from an original video (a replay is an experiment on the same
 * audio), each with the person who said it and the talk it was said in.
 */
const FEED = `
with recursive ${SURVIVOR_CTE},
feed as (
  select ${claimRepo.COLUMNS.split(", ").map((c) => `c.${c}`).join(", ")},
         sv.name as speaker_name, p.id as person_id, p.name as person_name, p.org as person_org, p.title as person_title,
         p.photo_url as person_photo_url, k.talk_id, t.title as talk_title,
         ss.source_url, ss.title as video_title, ss.started_at as video_started_at
  from claims c
  join sessions ss on ss.id = c.session_id
  left join survivor r on r.session_id = c.session_id and r.raw_id = c.speaker_id
  left join speakers sv on sv.session_id = c.session_id and sv.speaker_id = coalesce(r.cur, c.speaker_id)
  left join people p on p.id = sv.person_id
  ${TALK_AT}
  left join talks t on t.id = k.talk_id
  where ss.replay_of is null and c.status = 'ok'
)`;

interface Row extends claimRepo.Row {
  speaker_name: string | null;
  person_id: string | null;
  person_name: string | null;
  person_org: string | null;
  person_title: string | null;
  person_photo_url: string | null;
  talk_id: string | null;
  talk_title: string | null;
  source_url: string | null;
  video_title: string | null;
  video_started_at: Date | null;
}

const toItem = (row: Row): FeedItem =>
  FeedItem.parse({
    ...claimRepo.toClaim(row),
    speaker_name: row.speaker_name,
    person: row.person_id === null ? null : { id: Number(row.person_id), name: row.person_name, org: row.person_org, title: row.person_title, photo_url: row.person_photo_url },
    talk: row.talk_id === null ? null : { id: Number(row.talk_id), title: row.talk_title },
    video: {
      session_id: row.session_id,
      video_id: row.source_url ? videoIdFromUrl(row.source_url) : null,
      title: row.video_title,
      started_at: row.video_started_at?.toISOString() ?? null,
    },
  });

/** Newest first, a page at a time. `before` continues a list downwards; `after` asks only for what is newer than the reader has. */
export async function list(db: Queryable, query: FeedQuery): Promise<Feed> {
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const conds: string[] = [];
  if (query.before !== undefined) conds.push(`f.id < ${p(query.before)}`);
  if (query.after !== undefined) conds.push(`f.id > ${p(query.after)}`);
  if (query.kind !== undefined) conds.push(`f.kind = ${p(ClaimKind.parse(query.kind))}`);
  if (query.min_importance !== undefined) conds.push(`f.importance >= ${p(query.min_importance)}`);
  if (query.person !== undefined) conds.push(`f.person_id = ${p(query.person)}`);
  if (query.talk !== undefined) conds.push(`f.talk_id = ${p(query.talk)}`);
  if (query.session !== undefined) conds.push(`f.session_id = ${p(query.session)}`);
  const where = conds.length ? `where ${conds.join(" and ")}` : "";
  const { rows } = await db.query<Row>(`${FEED} select f.* from feed f ${where} order by f.id desc limit ${p(query.limit + 1)}`, params);
  const page = rows.slice(0, query.limit).map(toItem);
  return { items: page, next_before: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null };
}
