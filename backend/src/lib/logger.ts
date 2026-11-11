import pino from "pino";

import { config } from "../config";

/**
 * The newest log lines, kept in memory so GET /ops/logs can show them: nobody can read `docker logs` on the box from
 * outside it. Lost on a restart, which is when the box's own report (the container's log tail) takes over.
 */
const RING_CAPACITY = 3000;
const ring: Record<string, unknown>[] = [];

const destination = {
  write(line: string): void {
    process.stdout.write(line);
    try {
      ring.push(JSON.parse(line) as Record<string, unknown>);
      if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
    } catch {
      // Not a JSON line; stdout has it.
    }
  },
};

const root = pino({ level: config.LOG_LEVEL }, destination);

export function childLogger(bindings: { module: string }): pino.Logger {
  return root.child(bindings);
}

const LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** The newest `limit` lines at or above `level`, oldest first, optionally of one module or mentioning one text. */
export function recentLogs(opts: { limit: number; level?: string; module?: string; contains?: string }): Record<string, unknown>[] {
  const floor = LEVELS[opts.level ?? "trace"] ?? 10;
  const needle = opts.contains?.toLowerCase();
  const kept = ring.filter(
    (line) =>
      (typeof line.level !== "number" || line.level >= floor) &&
      (!opts.module || line.module === opts.module) &&
      (!needle || JSON.stringify(line).toLowerCase().includes(needle)),
  );
  return kept.slice(-opts.limit).map((line) => ({ ...line, time: typeof line.time === "number" ? new Date(line.time).toISOString() : line.time }));
}
