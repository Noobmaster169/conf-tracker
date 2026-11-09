import { ClaimHit, type ClaimSearch, type ClaimSearchQuery, type Lean, Polarity, type Speaker, type SpeakerFacet, type TopicFacet } from "../contracts";
import type { Queryable } from "../db";
import { videoIdFromUrl } from "../lib/youtube-id";
import * as claimRepo from "./claims";
import * as speakerRepo from "./speakers";

/** The speaker filter value for claims whose resolved speaker has no name, or that have no speaker at all. */
export const UNNAMED = "(unnamed)";

/**
 * Every claim with its speaker resolved to the survivor of any merges (depth-capped, so a cycle cannot loop) and its
 * session's fields. A label with no speakers row, or a chain the cap cut short, falls back to the raw label.
 */
const HITS = `
with recursive chain as (
  select session_id, speaker_id as raw_id, speaker_id as cur, merged_into, 0 as depth from speakers
  union all
  select c.session_id, c.raw_id, s.speaker_id, s.merged_into, c.depth + 1
  from chain c join speakers s on s.session_id = c.session_id and s.speaker_id = c.merged_into
  where c.depth < 20
),
survivor as (select session_id, raw_id, cur from chain where merged_into is null),
hits as (
  select c.id, c.session_id, c.call_id, c.speaker_id, c.t0, c.t1, c.claim, c.topics, c.polarity, c.quote, c.quote_verified,
         c.status, c.created_at,
         coalesce(r.cur, c.speaker_id) as survivor_id, sv.name as speaker_name, sv.role as speaker_role,
         ss.created_at as session_created_at, ss.started_at as session_started_at, ss.source_url, ss.source_file
  from claims c
  join sessions ss on ss.id = c.session_id
  left join survivor r on r.session_id = c.session_id and r.raw_id = c.speaker_id
  left join speakers sv on sv.session_id = c.session_id and sv.speaker_id = coalesce(r.cur, c.speaker_id)
  -- Replays are experiments on the same audio; counting them would double a show's claims.
  where ss.replay_of is null
)`;

const ORDER = "order by h.session_created_at desc, h.session_id asc, h.t0 asc nulls last, h.id asc";

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** One WHERE clause for the list, the count and every facet, so they cannot disagree. */
function where(query: ClaimSearchQuery, asOf: number | null): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const conds: string[] = [];
  if (!query.all) conds.push("h.status = 'ok'");
  if (asOf !== null) conds.push(`h.id <= ${p(asOf)}`);
  if (query.q) {
    const like = p(`%${escapeLike(query.q)}%`);
    conds.push(
      `(h.claim ilike ${like} escape '\\' or h.quote ilike ${like} escape '\\'` +
        ` or exists (select 1 from unnest(h.topics) t where t ilike ${like} escape '\\'))`,
    );
  }
  if (query.topic.length) conds.push(`exists (select 1 from unnest(h.topics) t where lower(t) = any(${p(query.topic.map((t) => t.toLowerCase()))}::text[]))`);
  if (query.speaker.length) {
    const named = query.speaker.filter((s) => s !== UNNAMED);
    const parts = named.length ? [`h.speaker_name = any(${p(named)}::text[])`] : [];
    if (named.length < query.speaker.length) parts.push("h.speaker_name is null");
    conds.push(`(${parts.join(" or ")})`);
  }
  if (query.polarity.length) conds.push(`h.polarity = any(${p(query.polarity)}::text[])`);
  if (query.session.length) conds.push(`h.session_id = any(${p(query.session)}::uuid[])`);
  return { sql: conds.length ? `where ${conds.join(" and ")}` : "", params };
}

const emptyLean = (): Lean => ({ bullish: 0, bearish: 0, neutral: 0, none: 0 });
const LEAN_SQL = Polarity.options.map((x) => `count(*) filter (where h.polarity = '${x}')::int as ${x}`).join(", ");
const toLean = (row: Record<string, unknown>): Lean => ({
  bullish: Number(row.bullish), bearish: Number(row.bearish), neutral: Number(row.neutral), none: Number(row.none),
});
const byCount = <T>(label: (x: T) => string | null) => (a: T & { count: number }, b: T & { count: number }): number => {
  if (b.count !== a.count) return b.count - a.count;
  const x = label(a);
  const y = label(b);
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
};
const top = (counts: Map<string, number>, n: number): string[] =>
  [...counts].map(([value, count]) => ({ value, count })).sort(byCount<{ value: string }>((x) => x.value)).slice(0, n).map((x) => x.value);

interface HitRow extends claimRepo.Row {
  survivor_id: string | null; speaker_name: string | null; speaker_role: string | null;
}

const toHit = (row: HitRow): ClaimHit =>
  ClaimHit.parse({ ...claimRepo.toClaim(row), speaker: { id: row.survivor_id, name: row.speaker_name, role: row.speaker_role } });

export async function search(db: Queryable, query: ClaimSearchQuery): Promise<ClaimSearch> {
  const asOf = query.as_of ?? (await db.query<{ max: string | null }>("select max(id) as max from claims")).rows[0]?.max ?? null;
  const pinned = asOf === null ? null : Number(asOf);
  const w = where(query, pinned);
  const n = w.params.length;

  const summary = (await db.query(`${HITS} select count(*)::int as total, ${LEAN_SQL} from hits h ${w.sql}`, w.params)).rows[0]!;
  const total = Number(summary.total);

  const items = (
    await db.query<HitRow>(`${HITS} select h.* from hits h ${w.sql} ${ORDER} offset $${n + 1} limit $${n + 2}`, [...w.params, query.offset, query.limit])
  ).rows.map(toHit);

  const shows = (
    await db.query<{ session_id: string; source_url: string | null; source_file: string | null; session_created_at: Date; session_started_at: Date | null; count: number }>(
      `${HITS} select h.session_id, h.source_url, h.source_file, h.session_created_at, h.session_started_at, count(*)::int as count
       from hits h ${w.sql}
       group by h.session_id, h.source_url, h.source_file, h.session_created_at, h.session_started_at
       order by h.session_created_at desc, h.session_id asc`,
      w.params,
    )
  ).rows.map((r) => ({
    session_id: r.session_id,
    video_id: r.source_url ? videoIdFromUrl(r.source_url) : null,
    source_file: r.source_file,
    created_at: r.session_created_at.toISOString(),
    started_at: r.session_started_at?.toISOString() ?? null,
    count: r.count,
  }));

  const speakerRows = (
    await db.query(`${HITS} select h.speaker_name as name, count(*)::int as count, ${LEAN_SQL} from hits h ${w.sql} group by h.speaker_name`, w.params)
  ).rows as ({ name: string | null; count: number } & Record<string, unknown>)[];

  // One row per (claim, lower-cased topic), so a claim tagged "Oil" and "oil" counts once for oil.
  const topicRows = (
    await db.query<{ topic: string; name: string | null; polarity: keyof Lean; count: number }>(
      `${HITS}, tagged as (select distinct h.id, lower(x) as topic, h.speaker_name as name, h.polarity from hits h, unnest(h.topics) x ${w.sql})
       select topic, name, polarity, count(*)::int as count from tagged group by topic, name, polarity`,
      w.params,
    )
  ).rows;

  const topicMap = new Map<string, { count: number; lean: Lean; voices: Map<string, number> }>();
  const speakerTopics = new Map<string | null, Map<string, number>>();
  for (const r of topicRows) {
    const entry = topicMap.get(r.topic) ?? { count: 0, lean: emptyLean(), voices: new Map() };
    entry.count += r.count;
    entry.lean[r.polarity] += r.count;
    if (r.name !== null) entry.voices.set(r.name, (entry.voices.get(r.name) ?? 0) + r.count);
    topicMap.set(r.topic, entry);
    const mine = speakerTopics.get(r.name) ?? new Map<string, number>();
    mine.set(r.topic, (mine.get(r.topic) ?? 0) + r.count);
    speakerTopics.set(r.name, mine);
  }
  const topics: TopicFacet[] = [...topicMap]
    .map(([value, e]) => ({ value, count: e.count, lean: e.lean, voices: top(e.voices, 2) }))
    .sort(byCount<TopicFacet>((x) => x.value));
  const speakers: SpeakerFacet[] = speakerRows
    .map((r) => ({ name: r.name, count: r.count, lean: toLean(r), topics: top(speakerTopics.get(r.name) ?? new Map(), 3) }))
    .sort(byCount<SpeakerFacet>((x) => x.name));

  // A page spans a handful of sessions, so one list per session is cheap.
  const session_speakers: Record<string, Speaker[]> = {};
  for (const id of new Set(items.map((i) => i.session_id))) session_speakers[id] = await speakerRepo.list(db, id);

  const next = query.offset + items.length;
  return {
    total, as_of: pinned, offset: query.offset, next_offset: next < total ? next : null, items, lean: toLean(summary),
    shows, topics, speakers, session_speakers,
  };
}
