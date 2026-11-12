# Agents

Every model call in this app is the work of an agent. An agent is described once, by an `AgentDefinition`
(`agent.ts`), and listed in `registry.ts`. Its id is the `step` of its rows in `llm_calls` and the name of its
directory under `prompts/`, so its calls belong to it with nothing else to keep in step.

A definition describes an agent; it does not run it. The run code is ordinary code that calls `callStructured`
(`structured.ts`) with the agent's prompt, and stores what the answer yields.

## What a listed agent gets for free

- A row on Admin › Agents and its own page: what it does, reads and writes.
- Every call it makes, with input and output, grouped into runs, each with the one line its `describe` gives.
- Its activity: its runs, and every change to its instructions or settings with who made it.
- Its instructions shown by version and editable as a new version; its settings shown with defaults and editable
  for new videos, running ones or both (`PATCH /agents/:id/settings`).
- "Run again" on any of its calls, when it has an `output` schema.
- The Watcher's coverage: an incident when it fails or is slow several runs in a row on a video.
- `ops/ct agents`, `ops/ct agent ID`, `ops/ct calls ID`.

## Adding an agent

The Watcher (`definitions/watch.ts`, `ingest/watcher.ts`) is the worked example of each step.

1. **Its settings.** A zod object with a default for every key, beside the others in `contracts.ts` or
   `contracts-agents.ts`: at least `<id>_prompt` (default `v1`) and `<id>_model`, an on/off switch named `<id>`, and
   `<id>_interval_s` if it runs on an interval. For an agent that works per video, add the schema to `configError`
   (`routes/sessions.routes.ts`) and to `configDefaults` (`routes/ops.routes.ts`), so its keys are checked and listed.
2. **Its instructions.** `prompts/<id>/v1.md`: frontmatter (`step`, `version`, `model`), then the text, with a
   `{{schema}}` line where the answer's shape is filled in.
3. **Its answer.** A zod schema for what it must answer. Free text is possible (`output: null`, as the summarizer)
   but then "run again" is not offered and nothing checks the answer's shape.
4. **Its definition.** `definitions/<id>.ts`, and one line in `registry.ts`. `describe` turns a call into one line
   ("3 claims", "Switched to DePIN panel"); return `failedLine(call)` first.
5. **Its run code.** Where it is triggered (a loop in `ingest/`, an event, a timer), build the input text and call
   `callStructured({ db, llm, sessionId, prompt }, Output, window, input, store)`. `store` writes what the answer
   yields in the same transaction as the call's row.
6. **Tests.** `test/agents-registry.test.ts` lists the ids in order; add yours. Test `describe`, and the run code with
   `fakeLlm`.

## Rules that are easy to break

- **A call belongs to a video.** `llm_calls.session_id` is not null. An agent with work that is about no video does
  that part without the model, as the Watcher does for the proxy, speech and the box.
- **Never insert an `extract` row that is not a real extraction window.** The extractor's cursor is its furthest
  answered call.
- **The id never changes once calls exist.** It is how old calls find their agent.
- **A new agent's answer is kept in `llm_calls.parsed`.** It needs a table of its own only when a public page must
  query it; then add a branch to `effectsFor` (`repositories/agent-runs.ts`) so the call says what it caused.
- **An agent whose calls are about the app, not the video's content, is `internal: true`.** Its calls stay out of the
  video's public feed and cost.
- **Whether the Watcher should notice it going quiet is a line in `watch-rules.ts`** (`CAN_GO_QUIET`): only for an
  agent that should run every interval while a video is live.
