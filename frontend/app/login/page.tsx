import { unlock } from "@/app/actions/access";
import { safeNext } from "@/lib/access";

export default async function Login({ searchParams }: PageProps<"/login">) {
  const { error, next } = await searchParams;
  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="mb-6 text-lg text-accent">conf-tracker</h1>
      <form action={unlock} className="mb-2 flex gap-2">
        <input type="hidden" name="next" value={safeNext(next)} />
        <input
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          aria-label="Password"
          placeholder="Password"
          className="flex-1 rounded border border-line bg-panel px-3 py-2 text-ink placeholder:text-ink-faint"
        />
        <button type="submit" className="rounded bg-accent px-4 py-2 text-bg">
          Enter
        </button>
      </form>
      {typeof error === "string" && <p className="text-bad">{error}</p>}
    </main>
  );
}
