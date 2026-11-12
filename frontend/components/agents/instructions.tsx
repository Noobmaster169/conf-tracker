import Link from "next/link";

import { saveInstructionsAction } from "@/app/actions/agents";
import { SubmitButton } from "@/components/admin/parts";
import { nextVersion } from "@/lib/agent-forms";
import type { AgentDetail, PromptText } from "@/lib/api-client";

import { Dialog } from "./dialog";

/** The instructions an agent works from: the version in use, the others, and the way to write a new one. */
export function Instructions({ agent, hrefFor }: { agent: AgentDetail; hrefFor: (view: string) => string }) {
  const inUse = agent.instructions.find((i) => i.in_use);
  const others = agent.instructions.filter((i) => !i.in_use);
  return (
    <div className="grid gap-3">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {inUse ? (
          inUse.exists ? (
            <Link href={hrefFor(inUse.version)} scroll={false} className="rounded-full bg-ink px-3 py-1 text-[13px] font-semibold text-paper">
              {inUse.version} in use
            </Link>
          ) : (
            <span className="rounded-full bg-live-soft px-3 py-1 text-[13px] font-semibold text-live">{inUse.version} is in use but does not exist</span>
          )
        ) : (
          <span className="text-ink-soft">No version is in use.</span>
        )}
        {others.map((i) => (
          <Link key={i.version} href={hrefFor(i.version)} scroll={false} className="rounded-full bg-sunk px-3 py-1 text-[13px] text-ink-soft hover:text-ink">
            {i.version}
          </Link>
        ))}
      </p>
      <p>
        <Link href={hrefFor("edit")} scroll={false} className="btn btn-quiet">
          Edit as a new version
        </Link>
      </p>
    </div>
  );
}

/** One version, to read. */
export function InstructionsWindow({ prompt, source, closeHref }: { prompt: PromptText; source: string; closeHref: string }) {
  return (
    <Dialog title={`Instructions ${prompt.version}`} sub={`${source === "file" ? "From the code" : source === "registered" ? "Written here" : "Written here, over the one in the code"} · written for ${prompt.model}`} closeHref={closeHref}>
      <pre className="max-h-[64vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-paper p-4 font-mono text-[12.5px] leading-relaxed">{prompt.text}</pre>
    </Dialog>
  );
}

/** The version in use, open to be changed. It is always saved as the next number: nothing that ran is ever rewritten. */
export function InstructionsEditor({ agent, current, closeHref }: { agent: AgentDetail; current: PromptText | null; closeHref: string }) {
  const version = nextVersion(agent.instructions);
  const needsSchema = current?.text.includes("{{schema}}") ?? false;
  return (
    <Dialog title={`New instructions for the ${agent.name}`} sub={`Saved as ${version}. ${current ? `Started from ${current.version}.` : ""}`} closeHref={closeHref}>
      <form action={saveInstructionsAction} className="grid gap-4">
        <input type="hidden" name="agent" value={agent.id} />
        <input type="hidden" name="back" value={closeHref} />
        <textarea name="text" defaultValue={current?.text ?? ""} required spellCheck={false} className="field min-h-[48vh] font-mono text-[12.5px] leading-relaxed" />
        {needsSchema && (
          <p className="text-[13px] text-ink-soft">
            Keep the line <code className="rounded bg-sunk px-1.5 py-0.5">{"{{schema}}"}</code> where it is: the shape of the answer is filled in there.
          </p>
        )}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[13px] font-medium text-ink-soft">After saving</legend>
          {[
            ["none", "Save only. Nothing uses it yet."],
            ["new", "Use it for new videos"],
            ["running", "Use it for the videos running now"],
            ["all", "Use it for both"],
          ].map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="apply" value={value} defaultChecked={value === "none"} />
              {label}
            </label>
          ))}
        </fieldset>
        <div>
          <SubmitButton working="Saving">Save as {version}</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
