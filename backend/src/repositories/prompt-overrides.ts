import type { Prompt } from "../agents/prompts/registry";
import type { Queryable } from "../db";

interface Row {
  step: string;
  version: string;
  model: string;
  max_tokens: number | null;
  text: string;
}

const toPrompt = (row: Row): Prompt =>
  row.max_tokens === null
    ? { step: row.step, version: row.version, model: row.model, text: row.text }
    : { step: row.step, version: row.version, model: row.model, maxTokens: row.max_tokens, text: row.text };

export async function list(db: Queryable): Promise<Prompt[]> {
  const { rows } = await db.query<Row>("select step, version, model, max_tokens, text from prompt_overrides order by step, version");
  return rows.map(toPrompt);
}

export async function put(db: Queryable, prompt: Prompt): Promise<Prompt> {
  const { rows } = await db.query<Row>(
    `insert into prompt_overrides (step, version, model, max_tokens, text) values ($1, $2, $3, $4, $5)
     on conflict (step, version) do update set model = excluded.model, max_tokens = excluded.max_tokens, text = excluded.text, updated_at = now()
     returning step, version, model, max_tokens, text`,
    [prompt.step, prompt.version, prompt.model, prompt.maxTokens ?? null, prompt.text],
  );
  return toPrompt(rows[0]!);
}

export async function remove(db: Queryable, step: string, version: string): Promise<boolean> {
  const { rowCount } = await db.query("delete from prompt_overrides where step = $1 and version = $2", [step, version]);
  return (rowCount ?? 0) > 0;
}
