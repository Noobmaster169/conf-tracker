import { ExtractConfig } from "../../contracts";
import { type AgentDefinition, failedLine } from "../agent";
import { ExtractOutput } from "../extract";

export const extractAgent: AgentDefinition = {
  id: "extract",
  name: "Extractor",
  role: "Pulls the claims out of what is said on stage.",
  trigger: { text: "Every 30 seconds of stream.", intervalKey: "extract_interval_s" },
  reads: ["the newest stretch of transcript", "the session on stage", "its own latest claims"],
  writes: ["claims"],
  settings: ExtractConfig,
  settingsScope: "video",
  promptKey: "extract_prompt",
  modelKey: "extract_model",
  fixedAtStart: ["extract", "extract_interval_s"],
  output: ExtractOutput,
  internal: false,
  describe(call, effects) {
    return failedLine(call) ?? (effects.claims === 0 ? "No claims" : effects.claims === 1 ? "1 claim" : `${effects.claims} claims`);
  },
};
