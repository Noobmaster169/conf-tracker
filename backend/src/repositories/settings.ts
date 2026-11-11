import type { Queryable } from "../db";

export interface Setting<T> {
  value: T;
  updated_at: string;
}

export async function get<T>(db: Queryable, key: string): Promise<Setting<T> | null> {
  const { rows } = await db.query<{ value: T; updated_at: Date }>("select value, updated_at from settings where key = $1", [key]);
  return rows[0] ? { value: rows[0].value, updated_at: rows[0].updated_at.toISOString() } : null;
}

export async function put<T>(db: Queryable, key: string, value: T): Promise<Setting<T>> {
  const { rows } = await db.query<{ value: T; updated_at: Date }>(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()
     returning value, updated_at`,
    [key, JSON.stringify(value)],
  );
  return { value: rows[0]!.value, updated_at: rows[0]!.updated_at.toISOString() };
}

/** The config a new video starts from, under whatever the request itself sets. Empty until someone sets it. */
export async function defaultConfig(db: Queryable): Promise<Record<string, unknown>> {
  return (await get<Record<string, unknown>>(db, "default_config"))?.value ?? {};
}
