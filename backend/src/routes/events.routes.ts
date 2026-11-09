import { Router } from "express";

import type { LiveEvent } from "../contracts";
import type { Queryable } from "../db";
import type { Hub } from "../realtime/hub";
import * as sessions from "../repositories/sessions";
import { buildSnapshot } from "./snapshot";

const KEEPALIVE_MS = 15_000;

/**
 * GET /sessions/:id/events. Catches the client up from Last-Event-ID (or ?after=) out of
 * the ring; when that seq has fallen out, sends a snapshot instead, then streams live.
 */
export function eventsRouter({ db, hub }: { db: Queryable; hub: Hub }): Router {
  const router = Router();

  router.get("/:id/events", async (req, res, next) => {
    let cleanup = (): void => {};
    try {
      const session = await sessions.get(db, req.params.id);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.status(200).set({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders();
      const write = (event: LiveEvent): void => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      // Subscribe before reading the ring so nothing published in between is lost.
      let ready = false;
      const pending: LiveEvent[] = [];
      const unsubscribe = hub.subscribe(session.id, (event) => (ready ? write(event) : pending.push(event)));
      const keepalive = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        res.write(": ping\n\n");
      }, KEEPALIVE_MS);
      let cleaned = false;
      cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(keepalive);
        unsubscribe();
      };
      // Registered before any await: a client that leaves during the snapshot read must still be released.
      res.on("close", cleanup);

      const afterRaw = req.headers["last-event-id"] ?? req.query.after;
      const after = typeof afterRaw === "string" ? Number(afterRaw) : NaN;
      const backlog = Number.isFinite(after) ? hub.since(session.id, after) : null;
      let current: number;
      if (backlog === null) {
        const snapshot = await buildSnapshot(db, hub, session);
        current = snapshot.seq;
        write({ seq: snapshot.seq, type: "snapshot", data: snapshot });
      } else {
        backlog.forEach(write);
        current = backlog.at(-1)?.seq ?? after;
      }
      ready = true;
      pending.filter((event) => event.seq > current).forEach(write);
    } catch (error) {
      cleanup();
      // The stream is already open, so there is no status left to send; ending it lets the client reconnect.
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    }
  });

  return router;
}
