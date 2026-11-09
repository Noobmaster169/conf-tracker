import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Applies every migration not yet recorded in schema_migrations, in filename
 * order, each in one transaction with its bookkeeping insert.
 */
export async function migrate({ log = console.log } = {}) {
  const client = new Client({
    host: required("PG_HOST"),
    port: Number(process.env.PG_PORT ?? "5434"),
    database: required("PG_DATABASE"),
    user: required("PG_USER"),
    password: required("PG_PASSWORD"),
  });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const { rows } = await client.query("select filename from schema_migrations");
    const done = new Set(rows.map((row) => row.filename));
    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
    const pending = files.filter((name) => !done.has(name));
    if (pending.length === 0) {
      log("Database is up to date.");
      return [];
    }
    for (const filename of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (filename) values ($1)", [filename]);
        await client.query("commit");
        log(`Applied ${filename}`);
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${filename} failed: ${error.message}`, { cause: error });
      }
    }
    return pending;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
