"use client";

import { useEffect, useReducer } from "react";

import { LiveEvent, type Snapshot } from "@/lib/api/schemas";
import type { Relay } from "@/lib/relay-ticket";
import { applyEvent, initialState, setConnection, type Connection, type SessionState } from "@/lib/session-state";

import { relayWatch, streamUrl, type Source } from "./stream-source";

type Action = { kind: "event"; event: LiveEvent; at: number } | { kind: "connection"; value: Connection };

function reduce(state: SessionState, action: Action): SessionState {
  return action.kind === "event" ? applyEvent(state, action.event, action.at) : setConnection(state, action.value);
}

const TYPES = ["snapshot", "segment", "segment.updated", "turns", "speaker", "health", "session", "call", "claims.new", "span", "person"] as const;

/**
 * One EventSource per page. The browser reconnects on its own and sends
 * Last-Event-ID, which the relay or the route handler honours, so a short drop replays
 * from the ring and a long one gets a fresh snapshot. With a relay, the stream opens there
 * first and moves to the Vercel route, once, if the relay refuses or stalls.
 */
export function useSessionStream(snapshot: Snapshot, relay: Relay | null): SessionState {
  const [state, dispatch] = useReducer(reduce, snapshot, initialState);

  // A video that has ended has nothing more to send, so it opens no stream: the page is the snapshot.
  const ended = snapshot.session.status === "stopped" || snapshot.session.status === "degraded";
  const relayUrl = relay?.url;
  const relayTicket = relay?.ticket;

  useEffect(() => {
    if (ended) return;
    const sessionId = snapshot.session.id;
    const viaRelay = relayUrl && relayTicket ? { url: relayUrl, ticket: relayTicket } : null;
    let lastSeq = snapshot.seq;
    let source: EventSource | null = null;
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
      lastSeq = parsed.data.seq;
      dispatch({ kind: "event", event: parsed.data, at: Date.now() });
    };
    const open = (kind: Source, onOpen?: () => void, onError?: (closed: boolean) => void) => {
      source?.close();
      const opened = new EventSource(streamUrl(sessionId, lastSeq, viaRelay, kind));
      source = opened;
      for (const type of TYPES) opened.addEventListener(type, onEvent);
      opened.onopen = () => {
        onOpen?.();
        dispatch({ kind: "connection", value: "open" });
      };
      opened.onerror = () => {
        const closed = opened.readyState === EventSource.CLOSED;
        dispatch({ kind: "connection", value: closed ? "closed" : "connecting" });
        onError?.(closed);
      };
    };
    if (!viaRelay) {
      open("vercel");
      return () => source?.close();
    }
    const watch = relayWatch(() => open("vercel"));
    open("relay", watch.opened, watch.errored);
    watch.started();
    return () => {
      watch.stop();
      source?.close();
    };
  }, [snapshot.session.id, snapshot.seq, ended, relayUrl, relayTicket]);

  return state;
}
