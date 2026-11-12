import { NameConfig } from "../../contracts";
import { type AgentDefinition, failedLine } from "../agent";
import { NameOutput } from "../name";

export const nameAgent: AgentDefinition = {
  id: "name",
  name: "Namer",
  role: "Works out who each voice is.",
  trigger: { text: "Every minute of stream, while a voice has no name.", intervalKey: "name_interval_s" },
  reads: ["the voices without a name", "what each said lately", "who is scheduled on stage"],
  writes: ["a name for a voice"],
  settings: NameConfig,
  settingsScope: "video",
  promptKey: "name_prompt",
  modelKey: "name_model",
  fixedAtStart: ["name", "name_interval_s"],
  output: NameOutput,
  internal: false,
  describe(call, effects) {
    const failed = failedLine(call);
    if (failed) return failed;
    const [first, ...rest] = effects.named;
    if (!first) return "No one named";
    return `Named ${first.voice} as ${first.name}${rest.length > 0 ? ` and ${rest.length} more` : ""}`;
  },
};
