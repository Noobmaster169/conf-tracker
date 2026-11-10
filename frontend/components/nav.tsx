"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Videos", match: /^\/($|video)/ },
  { href: "/monitor", label: "Monitor", match: /^\/monitor/ },
  { href: "/sessions", label: "Sessions", match: /^\/sessions/ },
  { href: "/speakers", label: "Speakers", match: /^\/speakers/ },
] as const;

function Item({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 font-medium ${active ? "bg-ink text-white" : "text-ink-soft hover:bg-sunk hover:text-ink"}`}
    >
      {label}
    </Link>
  );
}

/** The four places a reader goes, and the admin area set apart at the far end. */
export function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <nav aria-label="Main" className="mx-auto flex max-w-[1400px] items-center gap-1 overflow-x-auto px-4 py-2.5 sm:px-6">
        <Link href="/" className="mr-4 shrink-0 text-[17px] font-bold tracking-tight text-ink">
          Conference Tracker
        </Link>
        {LINKS.map((link) => (
          <Item key={link.href} href={link.href} label={link.label} active={link.match.test(path)} />
        ))}
        <span className="ml-auto" />
        <Item href="/admin" label="Admin" active={path.startsWith("/admin")} />
      </nav>
    </header>
  );
}
