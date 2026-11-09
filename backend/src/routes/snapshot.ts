import type { Session, Snapshot } from "../contracts";
import type { Queryable } from "../db";
import type { Hub } from "../realtime/hub";
import * as calls from "../repositories/calls";
import * as claims from "../repositories/claims";
import * as segments from "../repositories/segments";
import * as speakers from "../repositories/speakers";

const SNAPSHOT_SEGMENTS = 200;
const SNAPSHOT_CLAIMS = 50;
// Enough for the feed's head to show the last outcome after a reload, not a history.
const SNAPSHOT_CALLS = 10;

/** What a page needs to render before the first live event, stamped with the seq it is current to. */
export async function buildSnapshot(db: Queryable, hub: Hub, session: Session): Promise<Snapshot> {
  const seq = hub.lastSeq(session.id);
  const latestHealth = hub.latest(session.id, "health");
  // The row was read before the caller subscribed; a session event since then is newer and would not be replayed.
  const latestSession = hub.latest(session.id, "session");
  const recentCalls = await calls.latest(db, session.id, SNAPSHOT_CALLS);
  // The total stops at the newest call in the snapshot. A call inserted after that read is in neither, and its live
  // event adds its cost once; a call in the snapshot is known to the page, which then adds nothing for its event.
  const costUsd = await calls.totalCost(db, session.id, recentCalls.at(-1)?.id ?? 0);
  return {
    session: latestSession?.type === "session" ? latestSession.data : session,
    segments: await segments.latest(db, session.id, SNAPSHOT_SEGMENTS),
    health: latestHealth?.type === "health" ? latestHealth.data : null,
    speakers: await speakers.list(db, session.id),
    claims: await claims.latest(db, session.id, SNAPSHOT_CLAIMS),
    cost_usd: costUsd,
    calls: recentCalls,
    seq,
  };
}
