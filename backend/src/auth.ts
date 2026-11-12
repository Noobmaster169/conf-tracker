import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import { config } from "./config";

function equal(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One shared key, held by the Next.js server. Applied to everything except /health. */
export function requireCaller(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !equal(token, config.API_SHARED_SECRET)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Who says they are making this change: the `x-actor` header ("admin", "claude-code", anything). There is one shared
 * key, so this is a label for the record of changes, not a proof of anything.
 */
export function actorOf(req: Request): string {
  const header = req.headers["x-actor"];
  const value = (Array.isArray(header) ? header[0] : header)?.trim().slice(0, 40);
  return value || "unknown";
}
