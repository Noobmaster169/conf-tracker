"use client";

import { useEffect, useReducer } from "react";

import { LiveEvent, type Snapshot } from "@/lib/api/schemas";
import { applyEvent, initialState, setConnection, type Connection, type SessionState } from "@/lib/session-state";

type Action = { kind: "event"; event: LiveEvent; at: number } | { kind: "connection"; value: Connection };

function reduce(state: SessionState, action: Action): SessionState {
  return action.kind === "event" ? applyEvent(state, action.event, action.at) : setConnection(state, action.value);
}

const TYPES = ["snapshot", "segment", "segment.updated", "turns", "speaker", "health", "session", "call", "claims.new", "span", "person"] as const;

/**
 * One EventSource per page. The browser reconnects on its own and sends
 * Last-Event-ID, which the route handler forwards, so a short drop replays
 * from the ring and a long one gets a fresh snapshot.
 */
export function useSessionStream(snapshot: Snapshot): SessionState {
  const [state, dispatch] = useReducer(reduce, snapshot, initialState);

  // A video that has ended has nothing more to send, so it opens no stream: the page is the snapshot.
  const ended = snapshot.session.status === "stopped" || snapshot.session.status === "degraded";

  useEffect(() => {
    if (ended) return;
    const source = new EventSource(`/api/sessions/${encodeURIComponent(snapshot.session.id)}/events?after=${snapshot.seq}`);
    const onEvent = (message: MessageEvent<string>) => {
      let json: unknown = null;
      try {
        json = JSON.parse(message.data);
      } catch {
        json = null;
      }
      const parsed = LiveEvent.safeParse(json);
      if (!parsed.success) {
        console.warn("event outside the contract", parsed.error.issues[0]);
        return;
      }
      dispatch({ kind: "event", event: parsed.data, at: Date.now() });
    };
    for (const type of TYPES) source.addEventListener(type, onEvent);
    source.onopen = () => dispatch({ kind: "connection", value: "open" });
    source.onerror = () => dispatch({ kind: "connection", value: source.readyState === EventSource.CLOSED ? "closed" : "connecting" });
    return () => source.close();
  }, [snapshot.session.id, snapshot.seq, ended]);

  return state;
}
