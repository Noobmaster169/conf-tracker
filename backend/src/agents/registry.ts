import type { AgentDefinition } from "./agent";
import { extractAgent } from "./definitions/extract";
import { nameAgent } from "./definitions/name";
import { summarizeAgent } from "./definitions/summarize";
import { trackAgent } from "./definitions/track";
import { watchAgent } from "./definitions/watch";

/** Every agent, in the order work flows: who is on stage, who is speaking, what was claimed, the write-up, the watch over them. */
export const AGENTS: AgentDefinition[] = [trackAgent, nameAgent, extractAgent, summarizeAgent, watchAgent];

export const agentById = (id: string): AgentDefinition | null => AGENTS.find((agent) => agent.id === id) ?? null;

/** The agent whose settings hold this key. */
export const agentForKey = (key: string): AgentDefinition | null => AGENTS.find((agent) => agent.settings !== null && key in agent.settings.shape) ?? null;

/** Agents whose calls are left out of a video's public feed. */
export const internalAgentIds = (): string[] => AGENTS.filter((agent) => agent.internal).map((agent) => agent.id);
