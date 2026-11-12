/**
 * Runs agents again over a video prod already heard, in the local ct_eval copy (ops/eval pull), and compares results.
 * Driven by ops/eval; see its header for the commands. Nothing here reaches prod: it refuses any database but ct_eval.
 *
 * A run makes a variant video (sessions.replay_of = the original, sessions.eval = what was run) holding a copy of the
 * original's transcript and whatever the agents under test do not produce themselves, then plays those agents over it
 * on stream time, as fast as the model answers: the same loops, windows and prompts as live, with no speech.
 */
import { proxyLlmClient } from "../src/agents/llm-client";
import { setOverrides, shippedPrompt } from "../src/agents/prompts/registry";
import { config } from "../src/config";
import { ExtractConfig, NameConfig, PostConfig, SummaryConfig, TrackConfig } from "../src/contracts";
import { closePool, getPool } from "../src/db";
import { createExtractor } from "../src/ingest/extractor";
import type { Loop } from "../src/ingest/loop";
import { createNamer } from "../src/ingest/namer";
import { createPoster, withPost } from "../src/ingest/poster";
import { createSummarizer } from "../src/ingest/summarizer";
import { createTracker } from "../src/ingest/tracker";
import { createHub } from "../src/realtime/hub";
import * as promptOverrides from "../src/repositories/prompt-overrides";

if (config.PG_DATABASE !== "ct_eval") throw new Error(`eval runs only on the ct_eval copy, not ${config.PG_DATABASE}`);

const AGENTS = ["extract", "summarize", "post", "track", "name", "all"] as const;
type AgentArg = (typeof AGENTS)[number];
const KEYS: Record<Exclude<AgentArg, "all">, { prompt: string; model: string }> = {
  extract: { prompt: "extract_prompt", model: "extract_model" },
  summarize: { prompt: "summary_prompt", model: "summary_model" },
  post: { prompt: "post_prompt", model: "post_model" },
  track: { prompt: "track_prompt", model: "track_model" },
  name: { prompt: "name_prompt", model: "name_model" },
};

interface EvalInfo {
  agent: AgentArg;
  label: string | null;
  set: Record<string, unknown>;
  from: number | null;
  to: number | null;
  started: string;
  finished?: string;
  wall_s?: number;
}

const db = getPool();
/** Set after FAIL_LIMIT failed calls in a row: the model or the proxy is down, and every further call would fail too. */
let gaveUp = false;
const FAIL_LIMIT = 3;
const q = async <R extends object>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.query(sql, values)).rows as R[];

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value]);
    i++;
  }
  return { positional, flags };
}

/** A full id or the start of one. */
async function resolveSession(prefix: string): Promise<string> {
  const rows = await q<{ id: string }>("select id::text from sessions where id::text like $1 || '%'", [prefix]);
  if (rows.length !== 1) throw new Error(rows.length === 0 ? `no video ${prefix} in ct_eval (ops/eval list)` : `${prefix} names ${rows.length} videos`);
  return rows[0]!.id;
}

const fmtT = (t: number) => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const short = (id: string) => id.slice(0, 8);

async function list(): Promise<void> {
  const rows = await q<{ id: string; title: string | null; status: string; replay_of: string | null; eval: EvalInfo | null; len: number | null; claims: string; summaries: string; created_at: Date }>(
    `select s.id::text, s.title, s.status, s.replay_of::text, s.eval, s.created_at,
            (select max(t1) from segments g where g.session_id = s.id) as len,
            (select count(*) from claims c where c.session_id = s.id) as claims,
            (select count(*) from talk_summaries m where m.session_id = s.id) as summaries
       from sessions s order by coalesce(s.replay_of, s.id), s.created_at`,
  );
  for (const r of rows) {
    const what = r.eval
      ? `  variant of ${short(r.replay_of!)}: ${r.eval.agent} ${JSON.stringify(r.eval.set)}${r.eval.from !== null || r.eval.to !== null ? ` ${fmtT(r.eval.from ?? 0)}-${r.eval.to === null ? "end" : fmtT(r.eval.to)}` : ""}${r.eval.label ? ` "${r.eval.label}"` : ""}${r.eval.finished ? ` (${r.eval.wall_s}s)` : " (unfinished)"}`
      : `${r.title ?? "(untitled)"}, ${r.status}`;
    console.log(`${short(r.id)}  ${fmtT(r.len ?? 0)}  claims ${r.claims.padStart(4)}  summaries ${r.summaries.padStart(3)}  ${what}`);
  }
}

/** Steps through stream time, each loop at its own interval, earliest boundary first; at a tie the order given wins. */
async function playClock(loops: { name: string; loop: Loop; intervalS: number }[], fromT: number, endT: number): Promise<void> {
  const next = loops.map((l) => l.intervalS * (Math.floor(fromT / l.intervalS) + 1));
  let lastPrinted = -Infinity;
  for (;;) {
    if (gaveUp) return;
    let i = -1;
    for (let j = 0; j < loops.length; j++) if (next[j]! <= endT && (i < 0 || next[j]! < next[i]!)) i = j;
    if (i < 0) return;
    const t = next[i]!;
    if (t - lastPrinted >= 600) {
      process.stdout.write(`  ${fmtT(t)} / ${fmtT(endT)}\n`);
      lastPrinted = t;
    }
    await loops[i]!.loop.tick(t);
    next[i] = t + loops[i]!.intervalS;
  }
}

async function run(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const [agentArg, sessionArg] = positional;
  if (!AGENTS.includes(agentArg as AgentArg) || !sessionArg) throw new Error(`usage: run ${AGENTS.join("|")} SESSION [--prompt vN] [--model m] [--set k=v] [--from s] [--to s] [--label text]`);
  const agent = agentArg as AgentArg;
  const original = await resolveSession(sessionArg);
  const [orig] = await q<{ config: Record<string, unknown>; replay_of: string | null }>("select config, replay_of::text from sessions where id = $1", [original]);

  const set: Record<string, unknown> = {};
  for (const pair of flags.get("set") ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`--set ${pair}: want key=value`);
    const raw = pair.slice(eq + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    set[pair.slice(0, eq)] = value;
  }
  for (const flag of ["prompt", "model"] as const) {
    const value = flags.get(flag)?.at(-1);
    if (value === undefined) continue;
    if (agent === "all") throw new Error(`--${flag} is ambiguous for all; use --set extract_${flag}=...`);
    set[KEYS[agent][flag]] = value;
  }
  const num = (name: string) => {
    const v = flags.get(name)?.at(-1);
    if (v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} wants seconds`);
    return n;
  };
  const from = num("from");
  const to = num("to");

  const cfg: Record<string, unknown> = { ...orig!.config };
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete cfg[k];
    else cfg[k] = v;
  }
  // Each schema throws on a bad key value, and each loop below on an unknown prompt version, before any model call.
  const extractCfg = ExtractConfig.parse(cfg);
  const nameCfg = NameConfig.parse(cfg);
  const trackCfg = TrackConfig.parse(cfg);
  SummaryConfig.parse(cfg);
  PostConfig.parse(cfg);

  // Versions only prod knows (registered through the api) are usable here; a file on this machine wins over them,
  // so a draft vN.md is what runs.
  setOverrides((await promptOverrides.list(db)).filter((p) => shippedPrompt(p.step, p.version) === null));

  const info: EvalInfo = { agent, label: flags.get("label")?.at(-1) ?? null, set, from, to, started: new Date().toISOString() };
  const [variant] = await q<{ id: string }>(
    `insert into sessions (source_url, source_file, status, started_at, stopped_at, config, models, replay_of, stage_id, title, eval)
     select source_url, source_file, 'stopped', started_at, now(), $2, models, id, stage_id, title, $3 from sessions where id = $1 returning id::text`,
    [original, JSON.stringify(cfg), JSON.stringify(info)],
  );
  const id = variant!.id;
  await q(
    `insert into segments (session_id, t0, t1, text, words, created_at)
     select $2, t0, t1, text, words, created_at from segments where session_id = $1 and t0 >= $3 and ($4::float8 is null or t1 <= $4) order by t0, id`,
    [original, id, from ?? 0, to],
  );
  const renaming = agent === "name" || agent === "all";
  await q(
    `insert into speakers (session_id, speaker_id, first_seen_t, last_seen_t, talk_s, merged_into, created_at, name, role, name_confidence, name_quote, name_call_id, person_id)
     select $2, speaker_id, first_seen_t, last_seen_t, talk_s, merged_into, created_at,
            ${renaming ? "null, null, null, null, null, null" : "name, role, name_confidence, name_quote, name_call_id, person_id"}
       from speakers where session_id = $1`,
    [original, id],
  );
  if (agent !== "track" && agent !== "all") {
    await q(
      `insert into talk_spans (session_id, talk_id, state, t0, t1, confidence, quote, source, call_id, created_at)
       select $2, talk_id, state, t0, t1, confidence, quote, source, call_id, created_at from talk_spans where session_id = $1 order by t0, id`,
      [original, id],
    );
  }
  if (agent === "post") {
    // The Poster writes from what the other agents made: the original's claims and summaries, as they are.
    await q(
      `insert into claims (session_id, call_id, speaker_id, t0, t1, claim, topics, polarity, quote, quote_verified, status, created_at, kind, importance)
       select $2, call_id, speaker_id, t0, t1, claim, topics, polarity, quote, quote_verified, status, created_at, kind, importance
         from claims where session_id = $1 and t0 >= $3 and ($4::float8 is null or t0 <= $4) order by id`,
      [original, id, from ?? 0, to],
    );
    // Only the talks on stage inside --from/--to get a post, so a short run is a few calls.
    await q(
      `insert into talk_summaries (talk_id, session_id, call_id, summary, created_at)
       select m.talk_id, $2, m.call_id, m.summary, m.created_at from talk_summaries m
        where m.session_id = $1
          and exists (select 1 from talk_spans k where k.session_id = $1 and k.talk_id = m.talk_id and k.state = 'talk'
                       and ($4::float8 is null or k.t0 <= $4) and (k.t1 is null or k.t1 >= $3))
        order by m.id`,
      [original, id, from ?? 0, to],
    );
  }
  const [{ end } = { end: null }] = await q<{ end: number | null }>("select max(t1)::float8 as end from segments where session_id = $1", [id]);
  if (end === null) throw new Error("no transcript in that range");
  const startT = from ?? 0;
  console.log(`variant ${short(id)} of ${short(original)}: ${agent} ${JSON.stringify(set)} over ${fmtT(startT)}-${fmtT(end)}`);

  const hub = createHub(10);
  const llm = proxyLlmClient();
  const started = Date.now();
  let failedInARow = 0;
  hub.subscribe(id, (event) => {
    if (event.type !== "call") return;
    if (event.data.error === null) {
      failedInARow = 0;
      return;
    }
    console.log(`  ${event.data.step} ${fmtT(event.data.window_t1 ?? 0)} FAILED ${event.data.error.slice(0, 200)}`);
    if (++failedInARow >= FAIL_LIMIT && !gaveUp) {
      gaveUp = true;
      console.log(`  ${FAIL_LIMIT} failed calls in a row: giving up`);
    }
  });
  const post = createPoster({ db, llm });
  // The whole pipeline writes posts after summaries, as live does; summarize alone judges the summaries only.
  const summarize = agent === "all" ? withPost(createSummarizer({ db, llm }), post) : createSummarizer({ db, llm });

  if (agent === "extract") {
    const extractor = createExtractor({ db, hub, sessionId: id, llm, config: extractCfg });
    await playClock([{ name: "extract", loop: extractor, intervalS: extractCfg.extract_interval_s }], startT, end);
    if (!gaveUp) await extractor.flush();
  } else if (agent === "name") {
    const namer = createNamer({ db, hub, sessionId: id, llm, config: nameCfg });
    await playClock([{ name: "name", loop: namer, intervalS: nameCfg.name_interval_s }], startT, end);
  } else if (agent === "track") {
    const tracker = createTracker({ db, hub, sessionId: id, llm, config: trackCfg });
    await playClock([{ name: "track", loop: tracker, intervalS: trackCfg.track_interval_s }], startT, end);
    await tracker.tick();
    await tracker.flush();
  } else if (agent === "all") {
    // Live order on one clock: the tracker and the namer read first, so the extractor sees what they decided.
    const tracker = createTracker({ db, hub, sessionId: id, llm, config: trackCfg, summarize });
    const namer = createNamer({ db, hub, sessionId: id, llm, config: nameCfg });
    const extractor = createExtractor({ db, hub, sessionId: id, llm, config: extractCfg });
    await playClock(
      [
        { name: "track", loop: tracker, intervalS: trackCfg.track_interval_s },
        { name: "name", loop: namer, intervalS: nameCfg.name_interval_s },
        { name: "extract", loop: extractor, intervalS: extractCfg.extract_interval_s },
      ],
      startT,
      end,
    );
    if (!gaveUp) {
      await tracker.tick();
      await namer.tick();
      await extractor.flush();
      await tracker.flush(); // closes the timeline and writes every talk's summary
    }
  }
  if (agent === "summarize") {
    const talks = await q<{ talk_id: string }>("select distinct talk_id::text from talk_spans where session_id = $1 and state = 'talk' and talk_id is not null", [id]);
    const queue = talks.map((t) => Number(t.talk_id));
    const worker = async () => {
      for (let talkId = queue.shift(); talkId !== undefined; talkId = queue.shift()) {
        const summary = await summarize(id, talkId);
        console.log(`  talk ${talkId}: ${summary ? "written" : "nothing (too short, or the call failed)"}`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  if (agent === "post") {
    const talks = await q<{ talk_id: string }>("select distinct talk_id::text from talk_summaries where session_id = $1", [id]);
    const queue = talks.map((t) => Number(t.talk_id));
    const worker = async () => {
      for (let talkId = queue.shift(); talkId !== undefined; talkId = queue.shift()) {
        const written = await post(id, talkId, { force: true });
        console.log(`  talk ${talkId}: ${written ? "written" : "nothing (the call failed)"}`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  const wall = Math.round((Date.now() - started) / 1000);
  if (gaveUp) {
    console.log(`variant ${short(id)} is incomplete (left unfinished in ops/eval list); fix the cause and run again`);
    process.exitCode = 1;
    return;
  }
  await q("update sessions set eval = eval || $2 where id = $1", [id, JSON.stringify({ finished: new Date().toISOString(), wall_s: wall })]);
  const [calls] = await q<{ n: string; failed: string; in_tok: string | null; out_tok: string | null }>(
    "select count(*) n, count(*) filter (where error is not null) failed, sum(input_tokens) in_tok, sum(output_tokens) out_tok from llm_calls where session_id = $1",
    [id],
  );
  console.log(`done in ${wall}s: ${calls!.n} calls, ${calls!.failed} failed, ${calls!.in_tok ?? 0} tokens in, ${calls!.out_tok ?? 0} out`);
  console.log(`compare: ops/eval report ${short(id)}            (against the original, ${short(original)})`);
}

// ---------------------------------------------------------------- report

interface Side {
  id: string;
  label: string;
  from: number;
  to: number;
}

const within = (s: Side) => `t0 >= ${s.from} and t0 <= ${s.to}`;

async function callStats(side: Side, step: string): Promise<string> {
  const [r] = await q<{ n: string; failed: string; lat: number | null; in_tok: string | null; out_tok: string | null; versions: string | null }>(
    `select count(*) n, count(*) filter (where error is not null) failed, avg(latency_ms)::float8 / 1000 lat, sum(input_tokens) in_tok, sum(output_tokens) out_tok,
            string_agg(distinct prompt_version || '/' || model, ', ') versions
       from llm_calls where session_id = $1 and step = $2 and (window_t1 is null or (window_t1 >= $3 and window_t1 <= $4))`,
    [side.id, step, side.from, side.to + 60],
  );
  return `${r!.n} calls (${r!.versions ?? "none"}), ${r!.failed} failed, ${r!.lat === null ? "-" : r!.lat.toFixed(1)}s avg, ${r!.in_tok ?? 0} tokens in / ${r!.out_tok ?? 0} out`;
}

async function reportExtract(a: Side, b: Side, out: string[]): Promise<void> {
  type C = { t0: number; speaker: string | null; claim: string; kind: string | null; importance: number | null; status: string; quote: string };
  const load = (s: Side) =>
    q<C>(
      `select c.t0, coalesce(sp.name, c.speaker_id) speaker, c.claim, c.kind, c.importance, c.status, c.quote
         from claims c left join speakers sp on sp.session_id = c.session_id and sp.speaker_id = c.speaker_id
        where c.session_id = $1 and c.${within(s)} order by c.t0, c.id`,
      [s.id],
    );
  const [ca, cb] = await Promise.all([load(a), load(b)]);
  const stats = (cs: C[]) => {
    const kinds = new Map<string, number>();
    for (const c of cs) kinds.set(c.kind ?? "-", (kinds.get(c.kind ?? "-") ?? 0) + 1);
    const imp = cs.filter((c) => c.importance !== null);
    return {
      n: cs.length,
      unverified: cs.filter((c) => c.status !== "ok").length,
      imp: imp.length ? (imp.reduce((s, c) => s + c.importance!, 0) / imp.length).toFixed(2) : "-",
      high: cs.filter((c) => (c.importance ?? 0) >= 4).length,
      kinds: [...kinds].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", "),
    };
  };
  const sa = stats(ca);
  const sb = stats(cb);
  const minutes = Math.max(1, (a.to - a.from) / 60);
  out.push("## Extractor", "", `| | ${a.label} | ${b.label} |`, "|---|---|---|");
  out.push(`| claims | ${sa.n} (${(sa.n / minutes).toFixed(1)}/min) | ${sb.n} (${(sb.n / minutes).toFixed(1)}/min) |`);
  out.push(`| quote not found in transcript | ${sa.unverified} | ${sb.unverified} |`);
  out.push(`| mean importance / importance >= 4 | ${sa.imp} / ${sa.high} | ${sb.imp} / ${sb.high} |`);
  out.push(`| kinds | ${sa.kinds} | ${sb.kinds} |`);
  out.push(`| calls | ${await callStats(a, "extract")} | ${await callStats(b, "extract")} |`, "");
  out.push("### Claims side by side, per 5 minutes", "");
  const bucket = (t: number) => Math.floor(t / 300);
  const buckets = [...new Set([...ca, ...cb].map((c) => bucket(c.t0)))].sort((x, y) => x - y);
  const line = (c: C) => `- ${fmtT(c.t0)} [${c.kind ?? "-"} ${c.importance ?? "-"}${c.status === "ok" ? "" : " UNVERIFIED"}] ${c.speaker ? `${c.speaker}: ` : ""}${c.claim}`;
  for (const k of buckets) {
    const xa = ca.filter((c) => bucket(c.t0) === k);
    const xb = cb.filter((c) => bucket(c.t0) === k);
    out.push(`#### ${fmtT(k * 300)} (${xa.length} vs ${xb.length})`, "", `${a.label}:`, ...(xa.length ? xa.map(line) : ["- (none)"]), "", `${b.label}:`, ...(xb.length ? xb.map(line) : ["- (none)"]), "");
  }
}

async function reportSummaries(a: Side, b: Side, out: string[]): Promise<void> {
  const load = async (s: Side) =>
    new Map(
      (
        await q<{ talk_id: string; title: string; content: string }>(
          `select distinct on (m.talk_id) m.talk_id::text, t.title, coalesce(m.summary->>'content', m.summary::text) content
             from talk_summaries m join talks t on t.id = m.talk_id where m.session_id = $1 order by m.talk_id, m.created_at desc`,
          [s.id],
        )
      ).map((r) => [r.talk_id, r]),
    );
  const [ma, mb] = await Promise.all([load(a), load(b)]);
  // Only talks on stage inside the compared stretch: a variant over 10 minutes has nothing to say about the rest.
  const inRange = new Set(
    (
      await q<{ talk_id: string }>(
        "select distinct talk_id::text from talk_spans where session_id = any($1::uuid[]) and talk_id is not null and t0 <= $2 and (t1 is null or t1 >= $3)",
        [[a.id, b.id], a.to, a.from],
      )
    ).map((r) => r.talk_id),
  );
  for (const m of [ma, mb]) for (const key of [...m.keys()]) if (!inRange.has(key)) m.delete(key);
  const words = (s?: string) => (s ? s.split(/\s+/).length : 0);
  out.push("## Summarizer", "", `${ma.size} vs ${mb.size} talks summarised. A variant over part of a talk summarises only that part. ${a.label}: ${await callStats(a, "summarize")}. ${b.label}: ${await callStats(b, "summarize")}.`, "");
  for (const talkId of [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => Number(x) - Number(y))) {
    const x = ma.get(talkId);
    const y = mb.get(talkId);
    out.push(`### Talk ${talkId}: ${(x ?? y)!.title} (${words(x?.content)} vs ${words(y?.content)} words)`, "", `#### ${a.label}`, "", x?.content ?? "(none)", "", `#### ${b.label}`, "", y?.content ?? "(none)", "");
  }
}

async function reportPosts(a: Side, b: Side, out: string[]): Promise<void> {
  const load = async (s: Side) =>
    new Map(
      (
        await q<{ talk_id: string; title: string; text: string }>(
          `select distinct on (p.talk_id) p.talk_id::text, t.title, p.text from talk_posts p join talks t on t.id = p.talk_id where p.session_id = $1 order by p.talk_id, p.id desc`,
          [s.id],
        )
      ).map((r) => [r.talk_id, r]),
    );
  const [ma, mb] = await Promise.all([load(a), load(b)]);
  out.push("## Poster", "", `${ma.size} vs ${mb.size} posts. ${a.label}: ${await callStats(a, "post")}. ${b.label}: ${await callStats(b, "post")}.`, "");
  for (const talkId of [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => Number(x) - Number(y))) {
    const x = ma.get(talkId);
    const y = mb.get(talkId);
    out.push(`### Talk ${talkId}: ${(x ?? y)!.title}`, "", `#### ${a.label}`, "", "```", x?.text ?? "(none)", "```", "", `#### ${b.label}`, "", "```", y?.text ?? "(none)", "```", "");
  }
}

async function reportTrack(a: Side, b: Side, out: string[]): Promise<void> {
  type S = { talk_id: number | null; state: string; t0: number; t1: number | null; title: string | null };
  const load = (s: Side) =>
    q<S>("select p.talk_id::int, p.state, p.t0, p.t1, t.title from talk_spans p left join talks t on t.id = p.talk_id where p.session_id = $1 order by p.t0, p.id", [s.id]);
  const [sa, sb] = await Promise.all([load(a), load(b)]);
  const at = (ss: S[], t: number) => {
    let found: S | null = null;
    for (const s of ss) if (s.t0 <= t && (s.t1 === null || t < s.t1)) found = s;
    return found ? `${found.state}:${found.talk_id ?? ""}` : "none";
  };
  let same = 0;
  let total = 0;
  for (let t = a.from; t <= a.to; t += 10) {
    total++;
    if (at(sa, t) === at(sb, t)) same++;
  }
  const fmt = (s: S) => `- ${fmtT(s.t0)}-${s.t1 === null ? "open" : fmtT(s.t1)} ${s.state}${s.title ? `: ${s.title}` : ""}`;
  out.push("## Tracker", "", `Agree on what is on stage ${total ? Math.round((100 * same) / total) : 0}% of the time (sampled every 10 s).`, "");
  out.push(`${a.label}: ${await callStats(a, "track")}`, "", ...sa.filter((s) => s.t0 <= a.to && (s.t1 === null || s.t1 >= a.from)).map(fmt), "", `${b.label}: ${await callStats(b, "track")}`, "", ...sb.filter((s) => s.t0 <= a.to && (s.t1 === null || s.t1 >= a.from)).map(fmt), "");
}

async function reportNames(a: Side, b: Side, out: string[]): Promise<void> {
  const load = async (s: Side) =>
    new Map(
      (await q<{ speaker_id: string; name: string | null; c: number | null; talk_s: number | null }>("select speaker_id, name, name_confidence c, talk_s from speakers where session_id = $1 and merged_into is null", [s.id])).map((r) => [r.speaker_id, r]),
    );
  const [na, nb] = await Promise.all([load(a), load(b)]);
  // Seconds each voice speaks inside the compared stretch, from the words of the transcript.
  const heard = new Map(
    (
      await q<{ speaker_id: string; s: number }>(
        `select w->>'speaker_id' speaker_id, sum((w->>'t1')::float8 - (w->>'t0')::float8)::float8 s
           from segments g, jsonb_array_elements(g.words) w where g.session_id = $1 and g.t0 >= $2 and g.t1 <= $3 and w->>'speaker_id' is not null group by 1`,
        [a.id, a.from, a.to],
      )
    ).map((r) => [r.speaker_id, r.s]),
  );
  const rows = [...na.values()].map((r) => ({ ...r, talk_s: heard.get(r.speaker_id) ?? 0 })).filter((r) => r.talk_s >= 20).sort((x, y) => y.talk_s - x.talk_s);
  const cell = (r?: { name: string | null; c: number | null }) => (r?.name ? `${r.name} (${(r.c ?? 0).toFixed(2)})` : "-");
  const differ = rows.filter((r) => (r.name ?? "") !== (nb.get(r.speaker_id)?.name ?? "")).length;
  out.push("## Namer", "", `${rows.length} voices with 20 s or more in this stretch; ${differ} named differently. ${a.label}: ${await callStats(a, "name")}. ${b.label}: ${await callStats(b, "name")}.`, "");
  out.push(`| voice | talk | ${a.label} | ${b.label} |`, "|---|---|---|---|");
  for (const r of rows) out.push(`| ${r.speaker_id} | ${Math.round(r.talk_s)} s | ${cell(r)} | ${cell(nb.get(r.speaker_id))} |`);
  out.push("");
}

async function report(args: string[]): Promise<void> {
  const { positional } = parseFlags(args);
  if (!positional[0]) throw new Error("usage: report A [B]");
  const aId = await resolveSession(positional[0]);
  const [ar] = await q<{ replay_of: string | null; eval: EvalInfo | null }>("select replay_of::text, eval from sessions where id = $1", [aId]);
  const bId = positional[1] ? await resolveSession(positional[1]) : ar!.replay_of;
  if (!bId) throw new Error(`${short(aId)} is not a variant: name the second video`);
  const [br] = await q<{ eval: EvalInfo | null }>("select eval from sessions where id = $1", [bId]);
  const [{ end } = { end: 0 }] = await q<{ end: number }>("select coalesce(max(t1), 0)::float8 as end from segments where session_id = $1", [aId]);
  const describe = (id: string, e: EvalInfo | null) =>
    e ? `${short(id)} ${e.label || Object.entries(e.set).map(([k, v]) => `${k}=${v}`).join(" ") || `${e.agent} as in prod`}` : `${short(id)} prod`;
  const from = ar!.eval?.from ?? br!.eval?.from ?? 0;
  const to = Math.min(ar!.eval?.to ?? end, br!.eval?.to ?? Number.POSITIVE_INFINITY, end);
  const a: Side = { id: aId, label: describe(aId, ar!.eval), from, to };
  const b: Side = { id: bId, label: describe(bId, br!.eval), from, to };
  const agents = ar!.eval?.agent && ar!.eval.agent !== "all" ? [ar!.eval.agent] : ["track", "name", "extract", "summarize", "post"];
  const out = [`# ${a.label} vs ${b.label}`, "", `Stream time ${fmtT(from)}-${fmtT(to)}.`, ""];
  if (!br!.eval && ar!.eval && ar!.eval.agent !== "all")
    out.push(
      "> The prod side ran live: its agents saw names and the timeline as they were at the time, and other prompt versions may have run over the video. The variant saw the final ones. For a clean A/B, run the current version as a variant too and compare the two variants.",
      "",
    );
  for (const agent of agents) {
    if (agent === "extract") await reportExtract(a, b, out);
    if (agent === "summarize") await reportSummaries(a, b, out);
    if (agent === "post") await reportPosts(a, b, out);
    if (agent === "track") await reportTrack(a, b, out);
    if (agent === "name") await reportNames(a, b, out);
  }
  console.log(out.join("\n"));
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "list") await list();
  else if (command === "run") await run(rest);
  else if (command === "report") await report(rest);
  else throw new Error("commands: list, run, report");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
