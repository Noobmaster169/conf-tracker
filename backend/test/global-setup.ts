import { Client } from "pg";

import { migrate } from "../db/migrate.mjs";
import { TEST_ENV } from "../vitest.config";

/** Creates the test database once if missing, then migrates it. Refuses any database not named for tests. */
export default async function setup(): Promise<void> {
  if (!TEST_ENV.PG_DATABASE.endsWith("_test")) {
    throw new Error(`refusing to run tests against ${TEST_ENV.PG_DATABASE}: the name must end in _test`);
  }
  const admin = new Client({
    host: TEST_ENV.PG_HOST,
    port: Number(TEST_ENV.PG_PORT),
    database: "postgres",
    user: TEST_ENV.PG_USER,
    password: TEST_ENV.PG_PASSWORD,
  });
  await admin.connect();
  try {
    const found = await admin.query("select 1 from pg_database where datname = $1", [TEST_ENV.PG_DATABASE]);
    if (found.rowCount === 0) await admin.query(`create database ${TEST_ENV.PG_DATABASE}`);
  } finally {
    await admin.end();
  }
  Object.assign(process.env, TEST_ENV);
  await migrate({ log: () => undefined });
}
