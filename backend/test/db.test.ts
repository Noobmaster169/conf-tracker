import { afterAll, expect, test } from "vitest";

import { closePool } from "../src/db";
import { inRollback } from "./db";

afterAll(closePool);

test("the migration created the three tables", async () => {
  await inRollback(async (tx) => {
    const { rows } = await tx.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(["sessions", "segments", "events", "schema_migrations"]));
  });
});

test("sessions.status is constrained", async () => {
  await inRollback(async (tx) => {
    await expect(tx.query("insert into sessions (status) values ('bogus')")).rejects.toThrow(/check constraint/);
  });
});
