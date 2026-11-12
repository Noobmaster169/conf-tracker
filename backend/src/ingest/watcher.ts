import type { LlmClient } from "../agents/llm-client";
import { loadPrompt } from "../agents/prompts/registry";
import { callStructured } from "../agents/structured";
import { AGENTS } from "../agents/registry";
import { type Incident, slowMsFor, WatchOutput, type WatchSettings } from "../contracts-agents";
import type { Queryable } from "../db";
import { httpProbe, proxyHealthUrl, speechHealthUrl } from "../lib/health";
import { childLogger, recentLogs } from "../lib/logger";
import { videoIdFromUrl } from "../lib/youtube-id";
import * as runs from "../repositories/agent-runs";
import * as incidents from "../repositories/incidents";
import * as settings from "../repositories/settings";
import type { SessionRunner } from "./session-runner";
import { evaluate, type WatchFacts } from "./watch-rules";

const log = childLogger({ module: "watcher" });

/** A video nobody holds is still watched this long after it was made, for having stopped by itself or needing attention. */
const SCAN_DAYS = 7;
const RUNS_PER_AGENT = 10;

export interface WatcherDeps {
  db: Queryable;
  runner: SessionRunner;
  /** Whether the model proxy and speech answer. Tests give a fake. */
  health?: () => Promise<{ proxy: boolean; speech: boolean }>;
  /** Asked for a diagnosis of a new incident on a video; without it incidents are recorded undiagnosed. */
  llm?: LlmClient;
  now?: () => number;
}

export interface WatchReport {
  opened: number[];
  resolved: number[];
}

const realHealth = async (): Promise<{ proxy: boolean; speech: boolean }> => {
  const [proxy, speech] = await Promise.all([httpProbe(proxyHealthUrl()), httpProbe(speechHealthUrl())]);
  return { proxy: proxy.ok, speech: speech.ok };
};

/** The fixes that exist, lowest first: CLAUDE.md's ladder, as the Watcher is told it. */
const FIXES = `1. A wrong name, claim, title, schedule or session on stage: correct it in Admin (the video's page, Stages and videos, Speakers).
2. An agent gives bad answers or answers that do not match the expected shape: on the agent's page in Admin (Agents), edit its instructions as a new version and put it in use, or put the previous version back in use.
3. An agent is slow, too eager or too timid: on the agent's page, change its model or thresholds in Settings; they apply to running videos.
4. The model login expired (every agent fails with a login or authentication error): \`ops/ct job set-env '{"key":"CLAUDE_CODE_OAUTH_TOKEN","value":"..."}'\` with a new token.
5. The model proxy does not answer: \`ops/ct job restart '{"service":"llm-proxy"}'\`. Calls fail for some seconds and the next run picks up.
6. A video is recovering or needs attention: leave it, it retries by itself every minute. If it stopped: Resume in Admin.
7. Speech does not answer: wait. Only if it stays down, \`ops/ct job speech-restart\`, which also costs yt-stream's videos a catch-up.
8. The disk is full: \`ops/ct job prune\`, then \`ops/ct job recordings-clean\` for finished videos.
9. A deploy failed: the box kept what was running. Fix forward or \`git revert\`, and push.
10. Anything else: read \`ops/ct logs 200 warn\` and \`ops/ct status\` before changing anything.`;

/** What to call a video nobody has titled: its YouTube id is short and still finds it. */
const nameless = (url: string | null): string => {
  const id = url ? videoIdFromUrl(url) : null;
  return id ? `Video ${id}` : "An untitled video";
};

interface VideoRow {
  id: string;
  title: string | null;
  source_url: string | null;
  status: string;
  attention: string | null;
  replay_of: string | null;
  config: Record<string, unknown>;
  transcript_t: number;
  has_schedule: boolean;
}

/**
 * The fifth agent. Once a minute it reads how every agent's last runs went, each video's state, and whether the
 * proxy, speech and the box answer; what the rules find wrong becomes an incident in the database. It never throws
 * and never runs twice at once.
 */
export function createWatcher(deps: WatcherDeps): { pass(): Promise<WatchReport | null>; idle(): Promise<void> } {
  const { db, runner } = deps;
  const health = deps.health ?? realHealth;
  const now = deps.now ?? Date.now;
  let running = false;
  let proxyFails = 0;
  let speechFails = 0;
  let diagnosing: Promise<void> = Promise.resolve();

  async function facts(watch: WatchSettings): Promise<WatchFacts> {
    const { proxy, speech } = await health();
    proxyFails = proxy ? 0 : proxyFails + 1;
    speechFails = speech ? 0 : speechFails + 1;

    const held = new Set(runner.busy());
    const { rows } = await db.query<VideoRow>(
      `select s.id, s.title, s.source_url, s.status, s.attention, s.replay_of, s.config,
              coalesce((select max(g.t1) from segments g where g.session_id = s.id), 0)::float8 as transcript_t,
              exists (select 1 from talks t where t.stage_id = s.stage_id and t.archived_at is null) as has_schedule
         from sessions s
        where s.id = any($1::uuid[])
           or ((s.status = 'degraded' or s.attention is not null) and s.created_at > now() - make_interval(days => $2::int))
        order by s.created_at`,
      [[...held], SCAN_DAYS],
    );
    const watched = AGENTS.filter((agent) => !agent.internal);
    const videos: WatchFacts["videos"] = [];
    for (const row of rows) {
      const agents: WatchFacts["videos"][number]["agents"] = {};
      // A video nobody holds has no agents running: its runs are not read at all.
      for (const agent of held.has(row.id) ? watched : []) {
        const slowMs = slowMsFor(watch, agent.id);
        const recent = await runs.listRuns(db, { agentId: agent.id, sessionId: row.id, limit: RUNS_PER_AGENT, slowMs });
        const reach = await db.query<{ t1: number }>(`select coalesce(max(window_t1), 0)::float8 as t1 from llm_calls where session_id = $1 and step = $2`, [row.id, agent.id]);
        agents[agent.id] = { runs: recent.map((run) => ({ id: run.id, status: runs.statusOf(run, slowMs), error: run.error })), lastWindowT1: reach.rows[0]?.t1 ?? 0 };
      }
      videos.push({
        id: row.id, title: row.title ?? nameless(row.source_url), status: row.status, attention: row.attention, isReplay: row.replay_of !== null, held: held.has(row.id), hasSchedule: row.has_schedule,
        transcriptT: row.transcript_t, config: row.config ?? {}, agents,
      });
    }

    const box = await settings.get<Record<string, unknown>>(db, "box_report");
    const failed = box?.value.failed;
    return {
      videos,
      proxyFails,
      speechFails,
      box: { ageS: box ? Math.round((now() - Date.parse(box.updated_at)) / 1000) : null, failed: typeof failed === "string" && failed ? failed : null },
    };
  }

  async function record(watch: WatchSettings): Promise<WatchReport> {
    const findings = evaluate(await facts(watch), watch, AGENTS);
    const opened: number[] = [];
    const seen: number[] = [];
    const idOfRule = new Map<string, number>();
    // Parents first: system findings come first out of evaluate, and a child names its parent by rule.
    for (const finding of findings) {
      const parentId = finding.parentRule ? (idOfRule.get(finding.parentRule) ?? null) : null;
      const { incident, opened: isNew } = await incidents.upsertOpen(db, finding, parentId);
      seen.push(incident.id);
      if (finding.sessionId === null && finding.agentId === null) idOfRule.set(finding.rule, incident.id);
      if (isNew) opened.push(incident.id);
    }
    const resolved = await incidents.sweepCleared(db, seen, watch.clear_passes);
    return { opened, resolved };
  }

  /** One model call about a new incident on a video. A failed call leaves the incident as it is. */
  async function diagnose(incident: Incident, watch: WatchSettings): Promise<void> {
    if (!deps.llm || incident.session_id === null) return;
    const prompt = { ...loadPrompt("watch", watch.watch_prompt), model: watch.watch_model };
    const agent = AGENTS.find((a) => a.id === incident.agent_id) ?? null;
    const recent = agent ? await runs.listRuns(db, { agentId: agent.id, sessionId: incident.session_id, limit: 5, slowMs: slowMsFor(watch, agent.id) }) : [];
    const window = recent.find((run) => run.id === incident.call_id) ?? recent[0];
    const lines = recentLogs({ limit: 20, level: "warn" }).map((line) => `${String(line.module ?? "")}: ${String(line.msg ?? "")}${line.err ? ` (${String(line.err)})` : ""}`);
    const input = [
      `## the incident\n${incident.title}\n${incident.detail}`,
      `## the agent's latest runs, newest first\n${
        recent.map((run) => `- ${run.created_at}, instructions ${run.prompt_version}, ${run.model}, took ${Math.round(run.latency_ms / 1000)} s: ${run.error ?? "ok"}`).join("\n") || "none"
      }`,
      `## the newest warnings in the api's log\n${lines.join("\n") || "none"}`,
      `## the fixes that exist, lowest first\n${FIXES}`,
    ].join("\n\n");
    const { data } = await callStructured({ db, llm: deps.llm, sessionId: incident.session_id, prompt }, WatchOutput, { t0: window?.window_t0 ?? 0, t1: window?.window_t1 ?? 0 }, input);
    if (data) await incidents.setDiagnosis(db, incident.id, `${data.cause} Fix: ${data.fix}`);
  }

  return {
    async pass() {
      if (running) return null;
      running = true;
      try {
        const watch = await settings.watchSettings(db);
        if (!watch.enabled) return null;
        const report = await record(watch);
        if (report.opened.length > 0 || report.resolved.length > 0) log.warn(report, "incidents opened or resolved");
        // Diagnoses are asked for after the pass and outside its guard, one at a time: a model that is slow or hangs
        // must never stop the Watcher from looking. None while the proxy is failing: it could not answer, and the
        // live agents need what it has left.
        if (watch.diagnose && proxyFails === 0) {
          for (const id of report.opened) {
            diagnosing = diagnosing.then(async () => {
              const incident = await incidents.get(db, id);
              // Trouble filed under a system incident is explained by it already.
              if (incident && incident.parent_id === null && incident.resolved_at === null) await diagnose(incident, watch);
            }).catch((error) => log.warn({ incident: id, err: error instanceof Error ? error.message : String(error) }, "diagnosing an incident failed"));
          }
        }
        return report;
      } catch (error) {
        log.warn({ err: error instanceof Error ? error.message : String(error) }, "a watcher pass failed");
        return { opened: [], resolved: [] };
      } finally {
        running = false;
      }
    },
    /** Settles when every diagnosis asked for so far has been written or given up on. */
    idle: () => diagnosing,
  };
}
