import Link from "next/link";

import { saveSettingsAction } from "@/app/actions/agents";
import { SubmitButton } from "@/components/admin/parts";
import { fieldKind, fieldText } from "@/lib/agent-forms";
import type { AgentDetail, AgentSetting } from "@/lib/api-client";

const MODELS = ["haiku", "sonnet", "opus"];
const differs = (s: AgentSetting): boolean => JSON.stringify(s.value) !== JSON.stringify(s.default);

function Notes({ setting }: { setting: AgentSetting }) {
  return (
    <span className="flex flex-wrap gap-x-3 text-[12px] text-ink-faint">
      {differs(setting) && <span>default {fieldText(setting.default)}</span>}
      {setting.fixed_at_start && <span>read at a video&apos;s next start</span>}
      {!setting.valid && <span className="font-semibold text-live">the stored value is not valid</span>}
    </span>
  );
}

function Input({ setting, agent }: { setting: AgentSetting; agent: AgentDetail }) {
  const name = `s:${setting.key}`;
  const kind = fieldKind(setting);
  if (kind === "boolean") return <input type="checkbox" name={name} defaultChecked={setting.value === true} className="size-5" />;
  const value = fieldText(setting.value);
  const options = setting.key === agent.model_key ? MODELS : setting.key === agent.prompt_key ? agent.instructions.filter((i) => i.exists).map((i) => i.version) : null;
  if (options) {
    return (
      <select name={name} defaultValue={value} className="field">
        {[...new Set([value, ...options])].map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (kind === "json") return <textarea name={name} defaultValue={JSON.stringify(setting.value, null, 2)} spellCheck={false} className="field min-h-32 font-mono text-[12.5px]" />;
  return <input name={name} defaultValue={value} inputMode={kind === "number" ? "decimal" : undefined} placeholder={`default ${fieldText(setting.default)}`} className="field" />;
}

/** An agent's settings: read as a short list, edited in place. */
export function Settings({ agent, editing, editHref, closeHref }: { agent: AgentDetail; editing: boolean; editHref: string; closeHref: string }) {
  if (agent.settings.length === 0) return <p className="text-ink-soft">It has no settings.</p>;
  if (!editing) {
    return (
      <div className="grid gap-3">
        <dl className="divide-y divide-line">
          {agent.settings.map((setting) => (
            <div key={setting.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-2">
              <dt className="min-w-0 break-words font-mono text-[13px] text-ink-soft">{setting.key}</dt>
              <dd className={`max-w-[14rem] break-words text-right font-mono text-[13px] ${differs(setting) ? "font-semibold text-ink" : ""}`}>{fieldText(setting.value)}</dd>
              <dd className="col-span-2">
                <Notes setting={setting} />
              </dd>
            </div>
          ))}
        </dl>
        <p>
          <Link href={editHref} scroll={false} className="btn btn-quiet">
            Edit
          </Link>
        </p>
      </div>
    );
  }
  return (
    <form action={saveSettingsAction} className="grid gap-4">
      <input type="hidden" name="agent" value={agent.id} />
      <input type="hidden" name="back" value={closeHref} />
      <div className="grid grid-cols-1 gap-3">
        {agent.settings.map((setting) => (
          <label key={setting.key} className="block">
            <span className="mb-1 block font-mono text-[13px] text-ink-soft">{setting.key}</span>
            <Input setting={setting} agent={agent} />
            <Notes setting={setting} />
          </label>
        ))}
      </div>
      {agent.settings_scope === "video" ? (
        <label className="block max-w-md">
          <span className="mb-1 block text-[13px] font-medium text-ink-soft">Apply to</span>
          <select name="apply" defaultValue="all" className="field">
            <option value="all">New videos and the ones running now</option>
            <option value="new">New videos only</option>
            <option value="running">The videos running now only</option>
          </select>
          <span className="mt-3 flex items-start gap-2 text-[13px] text-ink-soft">
            <input type="checkbox" name="everything" className="mt-0.5 size-4" />
            <span>Send every value shown, not only the ones I change. Use it to bring the videos running now to exactly this, their own overrides included.</span>
          </span>
        </label>
      ) : (
        <p className="text-[13px] text-ink-soft">These apply to the whole app from its next look, within a minute.</p>
      )}
      <p className="text-[13px] text-ink-soft">Leave a field empty to take it back to its default.</p>
      <div className="flex gap-3">
        <SubmitButton working="Saving">Save</SubmitButton>
        <Link href={closeHref} scroll={false} className="btn btn-quiet">
          Cancel
        </Link>
      </div>
    </form>
  );
}
