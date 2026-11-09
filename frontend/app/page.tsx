import Link from "next/link";

import { startSession } from "@/app/actions/sessions";
import { Nav } from "@/components/nav";
import { listSessions } from "@/lib/api-client";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: PageProps<"/">) {
  const { error } = await searchParams;
  const sessions = await listSessions();
  return (
    <>
      <Nav current="sessions" />
      <main className="mx-auto max-w-3xl p-6">
        <form action={startSession} className="mb-2 flex gap-2">
          <input
            name="url"
            type="url"
            required
            aria-label="YouTube URL"
            placeholder="https://www.youtube.com/watch?v=..."
            className="flex-1 rounded border border-line bg-panel px-3 py-2 text-ink placeholder:text-ink-faint"
          />
          <button type="submit" className="rounded bg-accent px-4 py-2 text-bg">
            Ingest
          </button>
        </form>
        {typeof error === "string" && <p className="mb-4 text-bad">{error}</p>}
        <ul className="divide-y divide-line border-y border-line">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <Link href={`/session/${s.id}`} className="text-ink hover:text-accent">
                {s.video_id ?? s.source_file ?? s.id}
                {s.replay_of && <span className="ml-2 rounded border border-line px-1 text-xs text-ink-dim">replay</span>}
              </Link>
              <span className="text-ink-dim">
                {s.status} · {new Date(s.created_at).toLocaleString()}
              </span>
            </li>
          ))}
          {sessions.length === 0 && <li className="py-2 text-ink-dim">No sessions yet.</li>}
        </ul>
      </main>
    </>
  );
}
