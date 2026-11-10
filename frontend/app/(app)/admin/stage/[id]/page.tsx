import Link from "next/link";
import { notFound } from "next/navigation";

import { createTalkAction, importScheduleAction, removeTalkAction, updateStageAction, updateTalkAction, writeSummaryAction } from "@/app/actions/admin";
import { Field, Notice, Panel, SubmitButton, TalkFields } from "@/components/admin/parts";
import { Page } from "@/components/ui/bits";
import { getStage } from "@/lib/api-client";
import { plannedTime } from "@/lib/format";
import { formatSpeakers } from "@/lib/speakers-text";

export const dynamic = "force-dynamic";

const EXAMPLE = `10:00-10:30 | Opening keynote | Anatoly Yakovenko, Solana Labs, Co-Founder | keynote
10:30-11:15 | The state of DeFi | Jane Doe, Acme, CEO; John Roe, Beta (moderator) | panel
11:15-11:30 | Coffee | | break`;

export default async function StagePage({ params, searchParams }: PageProps<"/admin/stage/[id]">) {
  const { id } = await params;
  const { error, done } = await searchParams;
  const detail = await getStage(id);
  if (!detail) notFound();
  const { stage, talks } = detail;
  const back = `/admin/stage/${stage.id}`;
  return (
    <Page narrow>
      <p className="mb-2 text-ink-soft">
        <Link href="/admin" className="hover:text-accent hover:underline">
          Admin
        </Link>
      </p>
      <h1 className="mb-6 text-[28px] font-bold leading-tight tracking-tight">
        {stage.conference}, {stage.name}
        {stage.hidden && <span className="ml-3 rounded-full bg-sunk px-2.5 py-1 align-middle text-[13px] font-medium text-ink-soft">Hidden</span>}
      </h1>
      <Notice error={error} done={done} />
      <div className="grid gap-6">
        <Panel title="Stage">
          <form action={updateStageAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="id" value={stage.id} />
            <input type="hidden" name="back" value={back} />
            <Field label="Conference">
              <input name="conference" required defaultValue={stage.conference} className="field" />
            </Field>
            <Field label="Stage">
              <input name="name" required defaultValue={stage.name} className="field" />
            </Field>
            <Field label="Day">
              <input name="day" type="date" defaultValue={stage.day ?? ""} className="field" />
            </Field>
            <Field label="About the conference">
              <input name="description" defaultValue={stage.description} className="field" />
            </Field>
            <label className="flex items-start gap-2 sm:col-span-2">
              <input type="checkbox" name="hidden" defaultChecked={stage.hidden} className="mt-1" />
              <span>
                <span className="block font-medium">Hide from the app</span>
                <span className="block text-[13px] text-ink-soft">For a test run. Its sessions, videos, claims and the speakers known only from it leave every page but Admin, and come back when this is unticked.</span>
              </span>
            </label>
            <div className="sm:col-span-2">
              <SubmitButton quiet working="Saving">Save stage</SubmitButton>
            </div>
          </form>
        </Panel>

        <Panel title={`Schedule (${talks.length})`} lead="In running order. Planned times are a hint for the tracker, never a clock: a session is on stage when it is heard to be.">
          {talks.length === 0 && <p className="text-ink-soft">Nothing scheduled yet. Paste a schedule or add a session below.</p>}
          <ul className="divide-y divide-line">
            {talks.map((talk) => (
              <li key={talk.id}>
                <details className="group py-3">
                  <summary className="flex cursor-pointer items-baseline gap-4">
                    <span className="w-28 shrink-0 text-[13px] text-ink-soft">{plannedTime(talk.starts_at, talk.ends_at) ?? "No time"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold group-open:text-accent">{talk.title}</span>
                      <span className="block truncate text-[13px] text-ink-soft">{talk.speakers.map((s) => s.name).join(", ") || (talk.kind === "break" ? "Break" : "No speakers listed")}</span>
                    </span>
                    <span className="text-[13px] capitalize text-ink-faint">{talk.kind}</span>
                  </summary>
                  <form action={updateTalkAction} className="mt-4">
                    <input type="hidden" name="id" value={talk.id} />
                    <input type="hidden" name="back" value={back} />
                    <TalkFields values={{ ...talk, speakers: formatSpeakers(talk.speakers) }} />
                    <div className="mt-3">
                      <SubmitButton working="Saving">Save session</SubmitButton>
                    </div>
                  </form>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                    <Link href={`/sessions/${talk.id}`} className="btn btn-quiet">
                      Open its page
                    </Link>
                    <form action={writeSummaryAction}>
                      <input type="hidden" name="id" value={talk.id} />
                      <input type="hidden" name="back" value={back} />
                      <SubmitButton quiet working="Writing, this takes a minute">Write the summary again</SubmitButton>
                    </form>
                    <form action={removeTalkAction}>
                      <input type="hidden" name="id" value={talk.id} />
                      <input type="hidden" name="back" value={back} />
                      <SubmitButton quiet working="Removing">Remove from schedule</SubmitButton>
                    </form>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Paste a schedule" lead="One session per line: time, title, speakers and kind, separated by a vertical bar. Time and kind are optional. The sessions are added after the ones already here.">
          <form action={importScheduleAction} className="grid gap-3">
            <input type="hidden" name="stage_id" value={stage.id} />
            <input type="hidden" name="back" value={back} />
            <textarea name="text" required rows={7} placeholder={EXAMPLE} className="field font-mono text-[13px] leading-relaxed" aria-label="Schedule text" />
            <div>
              <SubmitButton working="Adding">Add these sessions</SubmitButton>
            </div>
          </form>
          {detail.text && (
            <details className="mt-4">
              <summary className="cursor-pointer text-[13px] font-medium text-ink-soft hover:text-ink">Copy the current schedule as text</summary>
              <textarea readOnly rows={Math.min(12, talks.length + 1)} defaultValue={detail.text} className="field mt-2 font-mono text-[13px] leading-relaxed" aria-label="Current schedule as text" />
            </details>
          )}
        </Panel>

        <Panel title="Add one session">
          <form action={createTalkAction}>
            <input type="hidden" name="stage_id" value={stage.id} />
            <input type="hidden" name="back" value={back} />
            <TalkFields />
            <div className="mt-3">
              <SubmitButton working="Adding">Add session</SubmitButton>
            </div>
          </form>
        </Panel>
      </div>
    </Page>
  );
}
