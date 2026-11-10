import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { config } from "./config";
import { childLogger } from "./lib/logger";

const log = childLogger({ module: "db" });

/** What a repository needs: satisfied by the pool and by a transaction client. */
export interface Queryable {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    database: config.PG_DATABASE,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    max: 10,
  });
  // An idle connection Postgres drops is reported on the pool; unhandled, it takes the process down.
  pool.on("error", (error) => log.warn({ err: error.message }, "an idle database connection was dropped"));
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  await closing.end();
}

export async function withTx<T>(db: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` as one transaction: its own on the pool, or the caller's when `db` is already a transaction's client (as it is
 * in tests). For a write that spans several tables and must not stop half way.
 */
export async function atomic<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db instanceof Pool ? withTx(db, fn) : fn(db);
}
