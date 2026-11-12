import Link from "next/link";
import { notFound } from "next/navigation";

import { Activity } from "@/components/agents/activity";
import { CallList } from "@/components/agents/call-list";
import { CallWindow } from "@/components/agents/call-window";
import { IncidentBanners } from "@/components/agents/incident-banner";
import { IncidentList } from "@/components/agents/incident-list";
import { Instructions, InstructionsEditor, InstructionsWindow } from "@/components/agents/instructions";
import { Rerun } from "@/components/agents/rerun";
import { RunStrip } from "@/components/agents/run-strip";
import { Settings } from "@/components/agents/settings-form";
import { Notice, Panel } from "@/components/admin/parts";
import { dotClass, lastRunText } from "@/lib/agents";
import { getAgent, getCall, getPrompt, listActivity, listAgentCalls, listIncidents } from "@/lib/api-client";

export const dynamic = "force-dynamic";

// Enough rows to fill a tall screen without paging; a line is one row of a table.
const PAGE = 30;
const FULL = 60;
const one = (value: string | string[] | undefined): string | undefined => (typeof value === "string" && value ? value : undefined);

function Labels({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-ink-soft">{title}</dt>
      <dd className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span key={item} className="rounded-full bg-sunk px-2.5 py-1 text-[13px]">
            {item}
          </span>
        ))}
      </dd>
    </div>
  );
}

/** One agent: what it is, and everything it did, each call openable to its input and output. */
export default async function AgentPage({ params, searchParams }: PageProps<"/admin/agents/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const agent = await getAgent(id);
  if (!agent) notFound();

  const status = one(query.status) === "failed" || one(query.status) === "slow" ? (one(query.status) as "failed" | "slow") : undefined;
  const session = one(query.session);
  const before = Number(one(query.before)) || undefined;
  const allCalls = one(query.view) === "calls" || before !== undefined;
  const callId = Number(one(query.call)) || undefined;
  const limit = allCalls ? FULL : PAGE;

  const isWatcher = agent.id === "watch";
  const instructionsView = one(query.instructions);
  const editingSettings = one(query.settings) === "edit";
  const inUse = agent.instructions.find((i) => i.in_use && i.exists)?.version;
  const wantedVersion = instructionsView === "edit" ? inUse : instructionsView;
  const [runs, opened, incidents, activity, promptText] = await Promise.all([
    listAgentCalls(id, { session, status, before, limit }),
    callId ? getCall(callId) : Promise.resolve(null),
    // The Watcher's page holds the whole record; any other agent's shows only what is wrong with it now.
    isWatcher ? listIncidents({ limit: 100 }) : listIncidents({ open: true, agent: agent.id }),
    listActivity(id, { limit: 100 }),
    wantedVersion ? getPrompt(agent.id, wantedVersion) : Promise.resolve(null),
  ]);
  const now = new Date();
  const base = `/admin/agents/${agent.id}`;
  // The calls have their own table; beside it only what was done to the agent is listed.
  const changes = activity.filter((line) => line.kind !== "call").slice(0, 12);

  /** This page's address with some of its parameters changed; null or undefined takes one away. */
  const href = (changes: Record<string, string | number | null | undefined>): string => {
    const next = new URLSearchParams();
    const current: Record<string, string | number | undefined> = { view: allCalls ? "calls" : undefined, session, status, before, call: callId, instructions: instructionsView, settings: editingSettings ? "edit" : undefined };
    for (const [key, value] of Object.entries({ ...current, ...changes })) if (value !== null && value !== undefined) next.set(key, String(value));
    const text = next.toString();
    return text ? `${base}?${text}` : base;
  };

  const videos = [...new Map(runs.map((run) => [run.session_id, run.session_title ?? "Untitled video"])).entries()];
  const filter = (label: string, to: string, current: boolean) => (
    <Link key={label} href={to} scroll={false} aria-current={current ? "true" : undefined} className={`rounded-full px-3 py-1 text-[13px] font-medium ${current ? "bg-ink text-paper" : "bg-sunk text-ink-soft hover:text-ink"}`}>
      {label}
    </Link>
  );
  const emptyText = isWatcher && !status ? "It has not had to ask the model about anything yet." : status === "failed" ? "No failed calls." : status === "slow" ? "No slow calls." : session ? "No calls on this video." : "It has not run yet.";

  return (
    <main className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 sm:py-10">
      {/* One compact band: who it is and what it works with. Everything below fits a wide screen side by side. */}
      <header className="mb-6 flex flex-wrap items-start gap-x-10 gap-y-4">
        <div className="min-w-0">
          <p className="mb-1 text-[13px] text-ink-soft">
            <Link href="/admin/agents" className="hover:text-accent hover:underline">
              Agents
            </Link>
          </p>
          <h1 className="flex items-center gap-3 text-[28px] font-bold leading-tight tracking-tight">
            <span className={`size-3 rounded-full ${dotClass(agent.status)}`} />
            {agent.name}
          </h1>
          <p className="mt-1 text-ink-soft">{agent.role}</p>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            {agent.trigger} Last asked the model: {lastRunText(agent, now)}.
          </p>
        </div>
        <dl className="flex min-w-0 basis-full flex-wrap gap-x-10 gap-y-3 pt-1 lg:flex-1 lg:basis-0">
          <Labels title="Reads" items={agent.reads} />
          <Labels title="Writes" items={agent.writes} />
        </dl>
        <div className="pt-1">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-soft">Last 24 runs</p>
          <RunStrip recent={agent.recent} />
        </div>
      </header>
      <Notice error={query.error} done={query.done} />
      {callId !== undefined && opened === null && <Notice error="That call no longer exists." />}

      {!isWatcher && <IncidentBanners incidents={incidents} now={now} />}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_25rem]">
        <div className="grid min-w-0 grid-cols-1 gap-5">
          {isWatcher && (
            <Panel title="Incidents" lead="What it found wrong. One that goes away closes itself. Mute one you already know about and it is not raised again while it lasts.">
              <IncidentList incidents={incidents} now={now} back={base} />
            </Panel>
          )}
          <Panel title={isWatcher ? "Its own calls" : "Calls"} lead={isWatcher ? "Each time it asked the model what was wrong with an incident." : "Every time it asked the model. Open one to read what it was given and what it answered."}>
            <div className="mb-3 flex flex-wrap gap-2">
              {filter("All", href({ status: null, before: null, call: null }), !status)}
              {filter("Failed", href({ status: "failed", before: null, call: null }), status === "failed")}
              {filter("Slow", href({ status: "slow", before: null, call: null }), status === "slow")}
              {session
                ? filter("Every video", href({ session: null, before: null, call: null }), false)
                : videos.length > 1 && videos.map(([vid, title]) => filter(title, href({ session: vid, before: null, call: null }), false))}
            </div>
            <CallList runs={runs} hrefFor={(call) => href({ call })} now={now} empty={emptyText} />
            <div className="mt-3 flex gap-4 text-[14px]">
              {runs.length === limit && (
                <Link href={href({ view: "calls", before: runs.at(-1)!.id, call: null })} className="font-medium text-accent hover:underline">
                  Older
                </Link>
              )}
              {before !== undefined && (
                <Link href={href({ view: null, before: null, call: null })} className="font-medium text-accent hover:underline">
                  Newest
                </Link>
              )}
            </div>
          </Panel>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-5">
          <Panel title="Instructions">
            <Instructions agent={agent} hrefFor={(view) => href({ instructions: view, call: null })} />
          </Panel>

          <Panel title="Settings" lead={agent.settings_scope === "video" ? "What new videos start with." : "How it watches, for the whole app."}>
            <div id="settings">
              <Settings agent={agent} editing={editingSettings} editHref={`${href({ settings: "edit", call: null })}#settings`} closeHref={href({ settings: null, call: null })} />
            </div>
          </Panel>

          <Panel title="Changes" lead="What was changed about it or tried on it, and by whom.">
            <Activity lines={changes} hrefFor={(call) => href({ call })} now={now} />
          </Panel>
        </div>
      </div>

      {instructionsView === "edit" && <InstructionsEditor agent={agent} current={promptText} closeHref={href({ instructions: null })} />}
      {instructionsView && instructionsView !== "edit" && promptText && (
        <InstructionsWindow prompt={promptText} source={agent.instructions.find((i) => i.version === promptText.version)?.source ?? "file"} closeHref={href({ instructions: null })} />
      )}
      {opened && (
        <CallWindow data={opened} videoTitle={runs.find((run) => run.session_id === opened.call.session_id)?.session_title ?? null} closeHref={href({ call: null })} now={now}>
          {agent.id === "summarize" ? (
            <p className="mt-6 border-t border-line pt-5 text-[13px] text-ink-soft">
              To write this summary again, open the session&apos;s stage under Stages and videos and use &quot;Write the summary again&quot;.
            </p>
          ) : (
            (() => {
              const versions = agent.instructions.filter((i) => i.exists).map((i) => i.version);
              const models = [...new Set([...(agent.model ? [agent.model] : []), "haiku", "sonnet", "opus"])];
              const version = versions.includes(opened.call.prompt_version) ? opened.call.prompt_version : (versions[0] ?? opened.call.prompt_version);
              return <Rerun key={opened.call.id} callId={opened.call.id} versions={versions} models={models} version={version} model={models[0]!} stored={opened.call.output} />;
            })()
          )}
        </CallWindow>
      )}
    </main>
  );
}
