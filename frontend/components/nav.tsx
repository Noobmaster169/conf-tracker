"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import type { Theme } from "@/lib/theme";

import { ThemeToggle } from "./theme-toggle";
import { useTrackPages } from "./ui/back-button";

const LINKS = [
  { href: "/", label: "Monitor", match: /^\/($|monitor)/ },
  { href: "/sessions", label: "Sessions", match: /^\/sessions/ },
  { href: "/speakers", label: "Speakers", match: /^\/speakers/ },
] as const;

function Item({ href, label, active, onClick, big = false }: { href: string; label: string; active: boolean; onClick?: () => void; big?: boolean }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`rounded-md font-medium ${big ? "flex min-h-11 items-center px-3 text-[16px]" : "px-3 py-1.5"} ${
        active ? "bg-sunk text-ink" : "text-ink-soft hover:bg-sunk hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}

function BurgerIcon({ open }: { open: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-[20px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
    </svg>
  );
}

/**
 * The three places a reader goes, and the admin area set apart at the far end. On a phone they fold behind a menu
 * button into a panel that slides in from the right; it closes on a choice, on Escape, or on a tap outside it.
 */
export function Nav({ theme }: { theme: Theme }) {
  const path = usePathname();
  useTrackPages();
  // The page the panel was opened on: moving to another page closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  const close = () => setOpenOn(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenOn(null);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex max-w-[1400px] items-center gap-1 px-4 py-2 sm:px-6 sm:py-2.5">
          <Link href="/" className="mr-4 shrink-0 text-[16px] font-semibold tracking-tight text-ink">
            Conference Tracker
          </Link>
          <div className="hidden items-center gap-1 sm:flex">
            {LINKS.map((link) => (
              <Item key={link.href} href={link.href} label={link.label} active={link.match.test(path)} />
            ))}
          </div>
          <span className="ml-auto" />
          <div className="hidden sm:block">
            <Item href="/admin" label="Admin" active={path.startsWith("/admin")} />
          </div>
          <ThemeToggle initial={theme} />
          <button
            type="button"
            onClick={() => setOpenOn(open ? null : path)}
            aria-label={open ? "Close the menu" : "Open the menu"}
            aria-expanded={open}
            aria-controls="nav-panel"
            className="flex size-10 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-sunk hover:text-ink sm:hidden"
          >
            <BurgerIcon open={open} />
          </button>
        </nav>
      </header>

      {/* Outside the header: its backdrop blur would otherwise pin the panel to the header's box. */}
      <div className={`fixed inset-0 z-40 sm:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
        <div onClick={close} className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
        <aside
          id="nav-panel"
          inert={!open}
          className={`absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col border-l border-line bg-surface shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none ${
            open ? "translate-x-0" : "translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <span className="text-[16px] font-semibold tracking-tight text-ink">Menu</span>
            <button type="button" onClick={close} aria-label="Close the menu" className="flex size-10 items-center justify-center rounded-md text-ink-soft hover:bg-sunk hover:text-ink">
              <BurgerIcon open />
            </button>
          </div>
          <nav aria-label="Main, on a phone" className="flex flex-1 flex-col gap-1 p-3">
            {LINKS.map((link) => (
              <Item key={link.href} href={link.href} label={link.label} active={link.match.test(path)} onClick={close} big />
            ))}
            <div className="mt-auto border-t border-line pt-3">
              <Item href="/admin" label="Admin" active={path.startsWith("/admin")} onClick={close} big />
            </div>
          </nav>
        </aside>
      </div>
    </>
  );
}
