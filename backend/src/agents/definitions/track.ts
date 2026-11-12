import { TrackConfig } from "../../contracts-conference";
import { type AgentDefinition, failedLine, field } from "../agent";
import { TrackOutput } from "../track";

export const trackAgent: AgentDefinition = {
  id: "track",
  name: "Tracker",
  role: "Works out which session is on stage.",
  trigger: { text: "Every minute of stream.", intervalKey: "track_interval_s" },
  reads: ["the stage's schedule", "the last minutes of transcript", "what it believed before"],
  writes: ["the timeline of sessions"],
  settings: TrackConfig,
  settingsScope: "video",
  promptKey: "track_prompt",
  modelKey: "track_model",
  fixedAtStart: ["track", "track_interval_s"],
  output: TrackOutput,
  internal: false,
  describe(call, effects) {
    const failed = failedLine(call);
    if (failed) return failed;
    if (effects.switchedTo) return `Switched to "${effects.switchedTo}"`;
    const state = field(call.parsed, "state");
    return state === "break" ? "Break" : state === "talk" ? "Still on the same session" : "Not sure";
  },
};
