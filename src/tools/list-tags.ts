import type pg from "pg";
import { listTags } from "../db/queries.js";
import { toTagCount } from "../formatters/mappers.js";

export async function handleListTags(
  pool: pg.Pool,
  _input: unknown
): Promise<string> {
  const tags = await listTags(pool);

  if (tags.length === 0) {
    return "No tags found in the journal.";
  }

  return JSON.stringify(tags.map(toTagCount), null, 2);
}
