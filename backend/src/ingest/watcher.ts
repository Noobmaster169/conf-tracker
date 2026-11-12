import type { LlmClient } from "../agents/llm-client";
import { AGENTS } from "../agents/registry";
import { slowMsFor, type WatchSettings } from "../contracts-agents";
import type { Queryable } from "../db";
import { httpProbe, proxyHealthUrl, speechHealthUrl } from "../lib/health";
import { childLogger } from "../lib/logger";
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

interface VideoRow {
  id: string;
  title: string | null;
  source_url: string | null;
  status: string;
  attention: string | null;
  replay_of: string | null;
  config: Record<string, unknown>;
  transcript_t: number;
}

/**
 * The fifth agent. Once a minute it reads how every agent's last runs went, each video's state, and whether the
 * proxy, speech and the box answer; what the rules find wrong becomes an incident in the database. It never throws
 * and never runs twice at once.
 */
export function createWatcher(deps: WatcherDeps): { pass(): Promise<WatchReport | null> } {
  const { db, runner } = deps;
  const health = deps.health ?? realHealth;
  const now = deps.now ?? Date.now;
  let running = false;
  let proxyFails = 0;
  let speechFails = 0;

  async function facts(watch: WatchSettings): Promise<WatchFacts> {
    const { proxy, speech } = await health();
    proxyFails = proxy ? 0 : proxyFails + 1;
    speechFails = speech ? 0 : speechFails + 1;

    const { rows } = await db.query<VideoRow>(
      `select s.id, s.title, s.source_url, s.status, s.attention, s.replay_of, s.config,
              coalesce((select max(g.t1) from segments g where g.session_id = s.id), 0)::float8 as transcript_t
         from sessions s
        where s.id = any($1::uuid[])
           or ((s.status = 'degraded' or s.attention is not null) and s.created_at > now() - make_interval(days => $2::int))
        order by s.created_at`,
      [runner.busy(), SCAN_DAYS],
    );
    const watched = AGENTS.filter((agent) => !agent.internal);
    const videos: WatchFacts["videos"] = [];
    for (const row of rows) {
      const agents: WatchFacts["videos"][number]["agents"] = {};
      for (const agent of watched) {
        const slowMs = slowMsFor(watch, agent.id);
        const recent = await runs.listRuns(db, { agentId: agent.id, sessionId: row.id, limit: RUNS_PER_AGENT, slowMs });
        const reach = await db.query<{ t1: number }>(`select coalesce(max(window_t1), 0)::float8 as t1 from llm_calls where session_id = $1 and step = $2`, [row.id, agent.id]);
        agents[agent.id] = { runs: recent.map((run) => ({ id: run.id, status: runs.statusOf(run, slowMs), error: run.error })), lastWindowT1: reach.rows[0]?.t1 ?? 0 };
      }
      videos.push({
        id: row.id, title: row.title ?? row.source_url ?? "a video", status: row.status, attention: row.attention, isReplay: row.replay_of !== null,
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

  return {
    async pass() {
      if (running) return null;
      running = true;
      try {
        const watch = await settings.watchSettings(db);
        if (!watch.enabled) return null;
        const report = await record(watch);
        if (report.opened.length > 0 || report.resolved.length > 0) log.warn(report, "incidents opened or resolved");
        return report;
      } catch (error) {
        log.warn({ err: error instanceof Error ? error.message : String(error) }, "a watcher pass failed");
        return { opened: [], resolved: [] };
      } finally {
        running = false;
      }
    },
  };
}
