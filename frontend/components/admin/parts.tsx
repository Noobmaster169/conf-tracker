import Link from "next/link";
import type { ReactNode } from "react";

import { SubmitButton } from "./submit-button";

/** What the last action did, read from the address the action sent the reader back to. */
export function Notice({ error, done }: { error?: string | string[]; done?: string | string[] }) {
  if (typeof error === "string") return <p role="alert" className="mb-6 rounded-lg bg-live-soft px-4 py-3 font-medium text-live">{error}</p>;
  if (typeof done === "string") return <p role="status" className="mb-6 rounded-lg bg-accent-soft px-4 py-3 font-medium text-accent">{done}</p>;
  return null;
}

export function AdminTabs({ current }: { current: "videos" | "speakers" }) {
  const tab = (key: string, href: string, label: string) => (
    <Link href={href} aria-current={current === key ? "page" : undefined} className={`border-b-2 px-1 pb-2 font-medium ${current === key ? "border-ink text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
      {label}
    </Link>
  );
  return (
    <div className="mb-8 flex gap-6 border-b border-line">
      {tab("videos", "/admin", "Stages and videos")}
      {tab("speakers", "/admin/speakers", "Speakers")}
    </div>
  );
}

export function Panel({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {lead && <p className="mt-1 max-w-[70ch] text-ink-soft">{lead}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[13px] font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[13px] text-ink-faint">{hint}</span>}
    </label>
  );
}

const KINDS = ["talk", "panel", "fireside", "keynote", "break", "other"];

export interface TalkValues {
  title?: string;
  kind?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  description?: string;
  speakers?: string;
}

/** The fields of one session, shared by "add" and "edit". */
export function TalkFields({ values = {} }: { values?: TalkValues }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_6rem_6rem]">
      <Field label="Title">
        <input name="title" required defaultValue={values.title} className="field" />
      </Field>
      <Field label="Kind">
        <select name="kind" defaultValue={values.kind ?? "talk"} className="field capitalize">
          {KINDS.map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
      </Field>
      <Field label="Starts">
        <input name="starts_at" placeholder="10:00" pattern="\d{1,2}:\d{2}" defaultValue={values.starts_at ?? ""} className="field" />
      </Field>
      <Field label="Ends">
        <input name="ends_at" placeholder="10:30" pattern="\d{1,2}:\d{2}" defaultValue={values.ends_at ?? ""} className="field" />
      </Field>
      <Field label="Speakers" hint="Name, Organisation, Title. Separate people with a semicolon; add (moderator) or (host) after one who is not a speaker." className="sm:col-span-4">
        <input name="speakers" defaultValue={values.speakers} placeholder="Anatoly Yakovenko, Solana Labs, Co-Founder; Jane Doe, Acme, CEO (moderator)" className="field" />
      </Field>
      <Field label="What it is about" hint="Optional. Helps the tracker recognise the session when it starts." className="sm:col-span-4">
        <textarea name="description" rows={2} defaultValue={values.description} className="field" />
      </Field>
    </div>
  );
}

export { SubmitButton };
