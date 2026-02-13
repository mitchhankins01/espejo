import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getEntryByUuid } from "../db/queries.js";
import { toEntryResult } from "../formatters/mappers.js";

export async function handleGetEntry(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_entry", input);

  const entry = await getEntryByUuid(pool, params.uuid);

  if (!entry) {
    return `No entry found with UUID "${params.uuid}". Check that the UUID is correct.`;
  }

  return JSON.stringify(toEntryResult(entry), null, 2);
}
