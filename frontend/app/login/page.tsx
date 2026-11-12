import { unlock } from "@/app/actions/access";
import { safeNext } from "@/lib/access";

export default async function Login({ searchParams }: PageProps<"/login">) {
  const { error, next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <h1 className="text-[28px] font-bold tracking-tight">Conference Tracker</h1>
      <p className="mb-6 mt-1 text-ink-soft">Enter the admin password to continue.</p>
      <form action={unlock} className="flex gap-2">
        <input type="hidden" name="next" value={safeNext(next ?? "/admin")} />
        <input name="password" type="password" required autoFocus autoComplete="current-password" aria-label="Password" placeholder="Password" className="field" />
        <button type="submit" className="btn">
          Enter
        </button>
      </form>
      {typeof error === "string" && <p role="alert" className="mt-3 font-medium text-live">{error}</p>}
    </main>
  );
}
