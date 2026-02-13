import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getEntriesByDateRange } from "../db/queries.js";
import { toEntryResult } from "../formatters/mappers.js";

export async function handleGetEntriesByDate(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_entries_by_date", input);

  const entries = await getEntriesByDateRange(
    pool,
    params.date_from,
    params.date_to,
    params.limit
  );

  if (entries.length === 0) {
    return `No entries found between ${params.date_from} and ${params.date_to}.`;
  }

  return JSON.stringify(entries.map(toEntryResult), null, 2);
}
