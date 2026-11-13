"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { Theme } from "@/lib/theme";

import { ThemeToggle } from "./theme-toggle";

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
      className={`rounded-md px-2 py-1.5 text-center font-medium sm:px-3 ${active ? "bg-sunk text-ink" : "text-ink-soft hover:bg-sunk hover:text-ink"}`}
    >
      {label}
    </Link>
  );
}

/**
 * The four places a reader goes, and the admin area set apart at the far end. On a phone the four take a row of their
 * own under the name, an equal share of the width each, so nothing scrolls.
 */
export function Nav({ theme }: { theme: Theme }) {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <nav aria-label="Main" className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-1 gap-y-1.5 px-4 py-2 sm:flex-nowrap sm:px-6 sm:py-2.5">
        <Link href="/" className="mr-auto shrink-0 text-[16px] font-semibold tracking-tight text-ink sm:mr-4">
          Conference Tracker
        </Link>
        <div className="order-last -mx-1 grid w-[calc(100%+0.5rem)] grid-cols-4 gap-1 sm:order-none sm:mx-0 sm:flex sm:w-auto">
          {LINKS.map((link) => (
            <Item key={link.href} href={link.href} label={link.label} active={link.match.test(path)} />
          ))}
        </div>
        <span className="hidden sm:ml-auto sm:block" />
        <Item href="/admin" label="Admin" active={path.startsWith("/admin")} />
        <ThemeToggle initial={theme} />
      </nav>
    </header>
  );
}
