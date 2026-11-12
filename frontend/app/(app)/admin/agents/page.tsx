import { AgentRow } from "@/components/agents/agent-row";
import { IncidentBanners } from "@/components/agents/incident-banner";
import { SystemLine } from "@/components/agents/system-line";
import { AdminTabs, Notice } from "@/components/admin/parts";
import { Page, PageHeader } from "@/components/ui/bits";
import { getOpsStatus, listAgents, listIncidents } from "@/lib/api-client";

export const dynamic = "force-dynamic";

/** Is anything wrong? Every agent in one line each; an agent's own page has the rest. */
export default async function AgentsPage({ searchParams }: PageProps<"/admin/agents">) {
  const { error, done } = await searchParams;
  const [agents, status, incidents] = await Promise.all([listAgents(), getOpsStatus().catch(() => null), listIncidents({ open: true, limit: 200 })]);
  const now = new Date();
  return (
    <Page narrow>
      <PageHeader title="Agents" lead="Who is working, and what each one just did." />
      <AdminTabs current="agents" />
      <Notice error={error} done={done} />
      <IncidentBanners incidents={incidents} now={now} />
      <ul className="overflow-hidden rounded-xl border border-line bg-surface">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} now={now} />
        ))}
      </ul>
      <SystemLine status={status} />
    </Page>
  );
}
