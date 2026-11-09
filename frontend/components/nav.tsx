import Link from "next/link";

const LINKS = [
  { key: "sessions", href: "/", label: "sessions" },
  { key: "claims", href: "/claims", label: "claims" },
] as const;

/** The two dashboards on one thin line; the page you are on reads brighter than the other. */
export function Nav({ current }: { current: "sessions" | "claims" }) {
  return (
    <nav aria-label="Main" className="flex items-baseline gap-5 border-b border-line bg-panel px-4 py-2">
      <span className="text-accent">yt-stream</span>
      {LINKS.map((link) => (
        <Link
          key={link.key}
          href={link.href}
          aria-current={current === link.key ? "page" : undefined}
          className={current === link.key ? "text-ink underline decoration-accent decoration-2 underline-offset-[6px]" : "text-ink-dim hover:text-ink"}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
