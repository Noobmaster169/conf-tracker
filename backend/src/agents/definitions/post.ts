import { PostConfig } from "../../contracts-conference";
import { type AgentDefinition, clip, failedLine, field } from "../agent";
import { PostOutput } from "../post";

export const postAgent: AgentDefinition = {
  id: "post",
  name: "Poster",
  role: "Writes a session's highlight post for X once its summary is written.",
  trigger: { text: "When a session's summary is written." },
  reads: ["the session's claims", "its summary", "its schedule entry", "who spoke"],
  writes: ["the session's post"],
  settings: PostConfig,
  settingsScope: "video",
  promptKey: "post_prompt",
  modelKey: "post_model",
  fixedAtStart: [],
  output: PostOutput,
  internal: false,
  describe(call) {
    const failed = failedLine(call);
    if (failed) return failed;
    const header = field(call.parsed, "post")?.split("\n")[0]?.replace(/^\p{Extended_Pictographic}\s*/u, "").replace(/^Just wrapped:\s*/i, "").trim();
    return header ? `Posted "${clip(header)}"` : "Wrote a post";
  },
};
