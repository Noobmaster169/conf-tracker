import type { OpsStatus } from "@/lib/api-client";

function Part({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={ok ? "" : "font-semibold text-live"}>{children}</span>;
}

const minutes = (seconds: number): string => (seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`);

/** The system under the agents, in one quiet line. A part that is in trouble is the only thing that stands out. */
export function SystemLine({ status }: { status: OpsStatus | null }) {
  if (!status) return <p className="mt-6 text-[13px] text-live">Could not read the system&apos;s status.</p>;
  const { box } = status;
  const running = status.api.live.length;
  return (
    <p className="mt-6 flex flex-wrap gap-x-2 gap-y-1 text-[13px] text-ink-soft">
      <span>{running === 0 ? "No video running" : `${running} video${running === 1 ? "" : "s"} running`}</span>
      <span aria-hidden>·</span>
      <Part ok={status.llm_proxy.ok}>{status.llm_proxy.ok ? "model proxy ok" : "the model proxy does not answer"}</Part>
      <span aria-hidden>·</span>
      <Part ok={status.speech.ok}>{status.speech.ok ? "speech ok" : "speech does not answer"}</Part>
      <span aria-hidden>·</span>
      {box === null ? (
        <span>the box has never reported</span>
      ) : (
        <>
          <Part ok={!box.stale}>{box.age_s === null ? "the box has not reported" : `box reported ${minutes(box.age_s)} ago`}</Part>
          {box.deployed && (
            <>
              <span aria-hidden>·</span>
              <span>running {box.deployed.slice(0, 7)}</span>
            </>
          )}
          {box.held_back && (
            <>
              <span aria-hidden>·</span>
              <span>a deploy is held back while a video runs</span>
            </>
          )}
          {box.failed && (
            <>
              <span aria-hidden>·</span>
              <Part ok={false}>a deploy failed</Part>
            </>
          )}
        </>
      )}
    </p>
  );
}
