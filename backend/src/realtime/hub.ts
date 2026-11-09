import type { DistributiveOmit, LiveEvent } from "../contracts";
import { childLogger } from "../lib/logger";
import { createRing, type Ring } from "./ring";

const log = childLogger({ module: "hub" });

export type Listener = (event: LiveEvent) => void;

export interface Hub {
  publish(sessionId: string, event: DistributiveOmit<LiveEvent, "seq">): LiveEvent;
  subscribe(sessionId: string, listener: Listener): () => void;
  since(sessionId: string, seq: number): LiveEvent[] | null;
  lastSeq(sessionId: string): number;
  latest(sessionId: string, type: LiveEvent["type"]): LiveEvent | null;
}

interface Channel {
  ring: Ring<LiveEvent>;
  listeners: Set<Listener>;
  latest: Map<string, LiveEvent>;
}

export function createHub(capacity: number): Hub {
  const channels = new Map<string, Channel>();
  const channel = (id: string): Channel => {
    let found = channels.get(id);
    if (!found) {
      found = { ring: createRing(capacity), listeners: new Set(), latest: new Map() };
      channels.set(id, found);
    }
    return found;
  };
  return {
    publish(sessionId, input) {
      const ch = channel(sessionId);
      const event = { ...input, seq: ch.ring.lastSeq() + 1 } as LiveEvent;
      ch.ring.push(event);
      ch.latest.set(event.type, event);
      for (const listener of ch.listeners) {
        try {
          listener(event);
        } catch (error) {
          // One dead response must not stop delivery to the others.
          log.warn({ err: error instanceof Error ? error.message : String(error), sessionId }, "listener failed");
        }
      }
      return event;
    },
    subscribe(sessionId, listener) {
      const ch = channel(sessionId);
      ch.listeners.add(listener);
      return () => ch.listeners.delete(listener);
    },
    // Reads never allocate, so a caller probing unknown ids cannot grow memory.
    since(sessionId, seq) {
      const ch = channels.get(sessionId);
      if (ch) return ch.ring.since(seq);
      return seq === 0 ? [] : null;
    },
    lastSeq: (sessionId) => channels.get(sessionId)?.ring.lastSeq() ?? 0,
    latest: (sessionId, type) => channels.get(sessionId)?.latest.get(type) ?? null,
  };
}
