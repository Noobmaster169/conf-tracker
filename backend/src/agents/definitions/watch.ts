import { WatchOutput, WatchSettings } from "../../contracts-agents";
import { type AgentDefinition, clip, failedLine, field } from "../agent";

export const watchAgent: AgentDefinition = {
  id: "watch",
  name: "Watcher",
  role: "Notices when something goes wrong and records it.",
  trigger: { text: "Every minute. It asks the model only when it has found something wrong on a video." },
  reads: ["every agent's latest runs", "each video's state", "the model proxy, speech and the box's report", "the log's warnings"],
  writes: ["incidents"],
  settings: WatchSettings,
  settingsScope: "global",
  promptKey: "watch_prompt",
  modelKey: "watch_model",
  fixedAtStart: [],
  output: WatchOutput,
  internal: true,
  describe(call) {
    return failedLine(call) ?? clip(field(call.parsed, "cause") ?? "Looked into an incident");
  },
};
