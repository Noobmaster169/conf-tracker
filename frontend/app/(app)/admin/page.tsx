import Link from "next/link";

import { createStageAction, resumeVideoAction, setNowAction, setVideoStageAction, stopVideoAction, trackVideoAction } from "@/app/actions/admin";
import { AdminTabs, Field, Notice, Panel, SubmitButton } from "@/components/admin/parts";
import { LiveBadge, Page, PageHeader } from "@/components/ui/bits";
import { isLive } from "@/components/ui/video-card";
import { listStages, listVideos, type StageWithTalks, type VideoCard } from "@/lib/api-client";
import { formatDay, plural } from "@/lib/format";
import { canResume, sessionState } from "@/lib/session-state";

export const dynamic = "force-dynamic";

const stageLabel = (s: StageWithTalks["stage"]): string => [s.conference, s.name, formatDay(s.day)].filter(Boolean).join(", ");

function StageSelect({ stages, value, empty }: { stages: StageWithTalks[]; value?: string | null; empty: string }) {
  return (
    <select name="stage_id" defaultValue={value ?? ""} className="field">
      <option value="">{empty}</option>
      {stages.map(({ stage }) => (
        <option key={stage.id} value={stage.id}>
          {stageLabel(stage)}
        </option>
      ))}
    </select>
  );
}

function VideoRow({ video, stages }: { video: VideoCard; stages: StageWithTalks[] }) {
  const { session } = video;
  const live = isLive(video);
  const state = sessionState(session, { behind_s: video.behind_s }, video.gaps);
  const resumable = canResume(session);
  const talks = stages.find((s) => s.stage.id === session.stage_id)?.talks ?? [];
  return (
    <li className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <Link href={`/video/${session.id}`} className="font-semibold hover:text-accent">
          {session.title ?? session.source_url ?? session.id}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-ink-soft">
          {state.label === "Live" ? <LiveBadge /> : <span className={state.label === "Needs attention" || state.label === "Recovering" ? "font-medium text-live" : undefined}>{state.label}</span>}
          {state.detail && <span>{state.detail}</span>}
          <span>{plural(video.claim_count, "claim")}</span>
          {live && <span>On stage: {video.now?.title ?? "not identified yet"}</span>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form action={setVideoStageAction} className="flex items-center gap-2">
          <input type="hidden" name="id" value={session.id} />
          <StageSelect stages={stages} value={session.stage_id} empty="No stage" />
          <SubmitButton quiet working="Moving">Set stage</SubmitButton>
        </form>
        {live && talks.length > 0 && (
          <form action={setNowAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={session.id} />
            <select name="talk_id" defaultValue={video.now?.id ?? "break"} className="field max-w-56" aria-label="Session on stage now">
              <option value="break">A break</option>
              {talks.map((talk) => (
                <option key={talk.id} value={talk.id}>
                  {talk.title}
                </option>
              ))}
            </select>
            <SubmitButton quiet working="Setting">Set on stage</SubmitButton>
          </form>
        )}
        {resumable && (
          <form action={resumeVideoAction}>
            <input type="hidden" name="id" value={session.id} />
            <SubmitButton working="Resuming">Resume</SubmitButton>
          </form>
        )}
        {live && (
          <form action={stopVideoAction}>
            <input type="hidden" name="id" value={session.id} />
            <SubmitButton quiet working="Stopping">Stop tracking</SubmitButton>
          </form>
        )}
      </div>
    </li>
  );
}

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const { error, done } = await searchParams;
  const [stages, videos] = await Promise.all([listStages(), listVideos(true)]);
  return (
    <Page>
      <PageHeader title="Admin" lead="Set up a stage and its schedule first, then point a video at it. The schedule is what lets the tracker tell sessions and speakers apart." />
      <AdminTabs current="videos" />
      <Notice error={error} done={done} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Track a video" lead="A YouTube livestream, or a recording of one. Tracking starts at once and the video appears on the Videos page.">
          <form action={trackVideoAction} className="grid gap-3">
            <Field label="YouTube link">
              <input name="url" type="url" required placeholder="https://www.youtube.com/watch?v=..." className="field" />
            </Field>
            <Field label="Stage" hint="Without a stage the video is still transcribed and mined for claims, but nothing is matched to a schedule.">
              <StageSelect stages={stages} empty="No stage" />
            </Field>
            <div>
              <SubmitButton working="Starting">Start tracking</SubmitButton>
            </div>
          </form>
        </Panel>
        <Panel title="Add a stage" lead="One stage of one conference on one day. Each stage has its own schedule and its own video.">
          <form action={createStageAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Conference">
              <input name="conference" required placeholder="Breakpoint 2026" className="field" />
            </Field>
            <Field label="Stage">
              <input name="name" required placeholder="Main stage" className="field" />
            </Field>
            <Field label="Day">
              <input name="day" type="date" className="field" />
            </Field>
            <Field label="About the conference" hint="A sentence. Given to the model as context.">
              <input name="description" placeholder="Solana's annual conference" className="field" />
            </Field>
            <label className="flex items-start gap-2 sm:col-span-2">
              <input type="checkbox" name="hidden"  className="mt-1" />
              <span>
                <span className="block font-medium">Hide from the app</span>
                <span className="block text-[13px] text-ink-soft">For a test run. Its sessions, videos, claims and the speakers known only from it leave every page but Admin, and come back when this is unticked.</span>
              </span>
            </label>
            <div className="sm:col-span-2">
              <SubmitButton working="Creating">Create stage</SubmitButton>
            </div>
          </form>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6">
        <Panel title="Stages">
          {stages.length === 0 ? (
            <p className="text-ink-soft">No stages yet. Add one above.</p>
          ) : (
            <ul className="divide-y divide-line">
              {stages.map(({ stage, talks, videos: bound }) => (
                <li key={stage.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-semibold">
                      {stageLabel(stage)}
                      {stage.hidden && <span className="ml-2 rounded-full bg-sunk px-2 py-0.5 text-[12px] font-medium text-ink-soft">Hidden</span>}
                    </p>
                    <p className="text-[13px] text-ink-soft">
                      {plural(talks.length, "session")}, {plural(bound.length, "video")}
                    </p>
                  </div>
                  <Link href={`/admin/stage/${stage.id}`} className="btn btn-quiet">
                    Edit schedule
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Videos">
          {videos.length === 0 ? <p className="text-ink-soft">No videos yet.</p> : <ul className="divide-y divide-line">{videos.map((video) => <VideoRow key={video.session.id} video={video} stages={stages} />)}</ul>}
        </Panel>
      </div>
    </Page>
  );
}
