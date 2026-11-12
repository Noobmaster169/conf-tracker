import { AgentRow } from "@/components/agents/agent-row";
import { IncidentBanners } from "@/components/agents/incident-banner";
import { SystemLine } from "@/components/agents/system-line";
import { AdminTabs, Notice } from "@/components/admin/parts";
import { PageHeader } from "@/components/ui/bits";
import { getOpsStatus, listAgentCalls, listAgents, listIncidents } from "@/lib/api-client";

export const dynamic = "force-dynamic";

/** Is anything wrong? Every agent in one line each; an agent's own page has the rest. */
export default async function AgentsPage({ searchParams }: PageProps<"/admin/agents">) {
  const { error, done } = await searchParams;
  const [agents, status, incidents] = await Promise.all([listAgents(), getOpsStatus().catch(() => null), listIncidents({ open: true, limit: 200 })]);
  // The last thing each one did, so the overview says more than "ok".
  const latest = await Promise.all(agents.map((agent) => listAgentCalls(agent.id, { limit: 1 }).then((runs) => runs[0] ?? null, () => null)));
  const now = new Date();
  return (
    <main className="mx-auto max-w-[1800px] px-4 py-8 sm:px-6 sm:py-10">
      <PageHeader title="Agents" lead="Who is working, and what each one just did.">
        <SystemLine status={status} />
      </PageHeader>
      <AdminTabs current="agents" />
      <Notice error={error} done={done} />
      <IncidentBanners incidents={incidents} now={now} />
      <ul className="overflow-hidden rounded-xl border border-line bg-surface">
        {agents.map((agent, i) => (
          <AgentRow key={agent.id} agent={agent} latest={latest[i] ?? null} now={now} />
        ))}
      </ul>
    </main>
  );
}
