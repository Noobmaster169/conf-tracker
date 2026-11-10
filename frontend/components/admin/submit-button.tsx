"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/** A form's button, which says it is working while the action runs so nobody presses twice. */
export function SubmitButton({ children, working = "Working", quiet = false }: { children: ReactNode; working?: string; quiet?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`btn ${quiet ? "btn-quiet" : ""}`}>
      {pending ? working : children}
    </button>
  );
}
