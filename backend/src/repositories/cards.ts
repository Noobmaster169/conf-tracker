import { PersonCard, TalkCard, VideoCard } from "../contracts-views";
import type { Queryable } from "../db";
import { videoIdFromUrl } from "../lib/youtube-id";
import { SURVIVOR_CTE } from "./feed";
import * as gaps from "./gaps";
import * as people from "./people";
import * as sessions from "./sessions";
import * as talks from "./talks";

/** The lists the app's pages open on: one query each, with the counts a card shows. */

const S_COLUMNS = sessions.COLUMNS.split(", ").map((c) => `s.${c}`).join(", ");
// to_jsonb of a missing left-joined row is an object of nulls, not null.
const STAGE_JSON = "case when g.id is null then null else to_jsonb(g) end as stage";

interface VideoRow extends sessions.SessionRow {
  stage: unknown;
  now_id: string | null;
  now_title: string | null;
  claim_count: number;
  duration_s: number;
  behind_s: number | null;
}

/** Every video ever tracked, newest first. Replays are experiments and are left out, and so are a hidden stage's videos unless asked for. */
export async function videos(db: Queryable, includeHidden = false): Promise<VideoCard[]> {
  const { rows } = await db.query<VideoRow>(
    `select ${S_COLUMNS}, ${STAGE_JSON}, n.id as now_id, n.title as now_title,
       (select count(*) from claims c where c.session_id = s.id and c.status = 'ok')::int as claim_count,
       coalesce((select max(t1) from segments where session_id = s.id), 0)::float8 as duration_s,
       case when s.status in ('starting', 'live', 'recovering') then
         (select (e.payload->>'behind_s')::float8 from events e where e.session_id = s.id and e.type = 'health' order by e.seq desc limit 1)
       end as behind_s
     from sessions s
     left join stages g on g.id = s.stage_id
     left join lateral (
       select t.id, t.title from talk_spans k join talks t on t.id = k.talk_id
       where k.session_id = s.id and k.t1 is null and k.state = 'talk' order by k.id desc limit 1
     ) n on true
     where s.replay_of is null and ($1 or not coalesce(g.hidden, false))
     order by s.created_at desc limit 200`,
    [includeHidden],
  );
  const open = await gaps.openFor(db, rows.map((row) => row.id));
  return rows.map((row) =>
    VideoCard.parse({
      session: sessions.toSession(row),
      stage: row.stage,
      now: row.now_id === null ? null : { id: Number(row.now_id), title: row.now_title },
      claim_count: row.claim_count,
      duration_s: row.duration_s,
      gaps: open.get(row.id) ?? [],
      behind_s: row.behind_s,
    }),
  );
}

interface TalkCardRow extends talks.TalkRow {
  stage: unknown;
  session_id: string | null;
  span_t0: number | null;
  span_t1: number | null;
  open: boolean | null;
  source_url: string | null;
  session_status: string | null;
  headline: string | null;
  claim_count: number;
}

export interface TalkFilter {
  id?: number;
  stageId?: string;
  personId?: number;
}

/**
 * The schedule as a reader sees it: each talk with where it was heard (the newest original video the tracker placed it
 * in), whether it is on now, and its summary's headline. Breaks are schedule context, not something to read, so they are left out.
 */
export async function talkCards(db: Queryable, filter: TalkFilter = {}): Promise<TalkCard[]> {
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const conds = ["t.archived_at is null", "t.kind <> 'break'"];
  // A hidden stage's talk is read by asking for it, never met in a list.
  if (filter.id !== undefined) conds.push(`t.id = ${p(filter.id)}`);
  else conds.push("not g.hidden");
  if (filter.stageId !== undefined) conds.push(`t.stage_id = ${p(filter.stageId)}`);
  if (filter.personId !== undefined) conds.push(`exists (select 1 from talk_speakers x where x.talk_id = t.id and x.person_id = ${p(filter.personId)})`);
  const { rows } = await db.query<TalkCardRow>(
    `select ${talks.FIELDS}, to_jsonb(g) as stage, sp.session_id, sp.t0 as span_t0, sp.t1 as span_t1, sp.open,
       ss.source_url, ss.status as session_status,
       (select m.summary->>'headline' from talk_summaries m where m.talk_id = t.id order by m.id desc limit 1) as headline,
       (select count(*) from claims c where c.session_id = sp.session_id and c.status = 'ok' and exists (
          select 1 from talk_spans k where k.session_id = c.session_id and k.talk_id = t.id and k.state = 'talk'
            and c.t0 >= k.t0 and (k.t1 is null or c.t0 < k.t1)))::int as claim_count
     from talks t
     join stages g on g.id = t.stage_id
     left join lateral (
       select k.session_id, min(k.t0) as t0, max(k.t1) as t1, bool_or(k.t1 is null) as open
       from talk_spans k join sessions s2 on s2.id = k.session_id
       where k.talk_id = t.id and k.state = 'talk' and s2.replay_of is null
       group by k.session_id order by max(k.id) desc limit 1
     ) sp on true
     left join sessions ss on ss.id = sp.session_id
     where ${conds.join(" and ")}
     order by g.day desc nulls last, g.created_at desc, t.position asc, t.id asc`,
    params,
  );
  return rows.map((row) => {
    const running = row.open === true && (row.session_status === "live" || row.session_status === "starting");
    return TalkCard.parse({
      talk: talks.toTalk(row),
      stage: row.stage,
      status: row.session_id === null ? "upcoming" : running ? "live" : "ended",
      session_id: row.session_id,
      video_id: row.source_url ? videoIdFromUrl(row.source_url) : null,
      t0: row.span_t0,
      t1: row.open ? null : row.span_t1,
      claim_count: row.claim_count,
      headline: row.headline,
    });
  });
}

interface PersonCardRow extends people.PersonRow {
  claim_count: number;
  talk_count: number;
  last_seen: Date | null;
}

/**
 * Everyone the app knows, whether heard on a video or only scheduled so far; the most quoted first. Someone who came
 * in with a hidden stage and is on nothing else is left out of the list, and still answers by id. A person who was
 * already known before that stage existed stays: a test run does not take a real speaker with it.
 */
export async function peopleCards(db: Queryable, id?: number, includeHidden = false): Promise<PersonCard[]> {
  const { rows } = await db.query<PersonCardRow>(
    `with recursive ${SURVIVOR_CTE},
     said as (
       select sv.person_id, count(*)::int as n, max(c.created_at) as last
       from claims c
       join sessions ss on ss.id = c.session_id and ss.replay_of is null
       left join stages sg on sg.id = ss.stage_id
       left join survivor r on r.session_id = c.session_id and r.raw_id = c.speaker_id
       join speakers sv on sv.session_id = c.session_id and sv.speaker_id = coalesce(r.cur, c.speaker_id)
       where c.status = 'ok' and sv.person_id is not null and not coalesce(sg.hidden, false)
       group by sv.person_id
     )
     select ${people.COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")}, coalesce(said.n, 0) as claim_count, said.last as last_seen,
       (select count(*) from talk_speakers ts join talks t on t.id = ts.talk_id where ts.person_id = p.id and t.archived_at is null)::int as talk_count
     from people p left join said on said.person_id = p.id
     left join lateral (
       select coalesce(bool_or(not x.hidden), false) as any_shown, min(x.created_at) filter (where x.hidden) as hidden_since from (
         select g.hidden, g.created_at from talk_speakers ts join talks t on t.id = ts.talk_id join stages g on g.id = t.stage_id
         where ts.person_id = p.id and t.archived_at is null
         union all
         select coalesce(g.hidden, false), g.created_at from speakers v join sessions s on s.id = v.session_id left join stages g on g.id = s.stage_id
         where v.person_id = p.id
       ) x
     ) seen on true
     where ($1::bigint is null or p.id = $1) and ($1::bigint is not null or $2 or seen.any_shown or seen.hidden_since is null or p.created_at < seen.hidden_since)
     order by claim_count desc, p.name asc`,
    [id ?? null, includeHidden],
  );
  return rows.map((row) =>
    PersonCard.parse({ person: people.toPerson(row), claim_count: row.claim_count, talk_count: row.talk_count, last_seen: row.last_seen?.toISOString() ?? null }),
  );
}
