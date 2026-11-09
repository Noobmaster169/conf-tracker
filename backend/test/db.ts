import type { PoolClient } from "pg";

import { getPool } from "../src/db";

/** Runs `fn` inside a transaction that is always rolled back, so tests leave no rows. */
export async function inRollback<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}
