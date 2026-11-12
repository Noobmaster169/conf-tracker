import { SummaryConfig } from "../../contracts-conference";
import { type AgentDefinition, clip, failedLine, field } from "../agent";

export const summarizeAgent: AgentDefinition = {
  id: "summarize",
  name: "Summarizer",
  role: "Writes up a session when it leaves the stage.",
  trigger: { text: "When a session leaves the stage." },
  reads: ["the session's whole transcript", "its schedule entry", "who spoke"],
  writes: ["the session's summary"],
  settings: SummaryConfig,
  settingsScope: "video",
  promptKey: "summary_prompt",
  modelKey: "summary_model",
  fixedAtStart: [],
  // It answers in markdown, not against a schema; only the headline is kept apart.
  output: null,
  internal: false,
  describe(call, effects) {
    const failed = failedLine(call);
    if (failed) return failed;
    const title = field(call.parsed, "headline") ?? effects.summaryOf;
    return title ? `Wrote "${clip(title)}"` : "Wrote a summary";
  },
};
