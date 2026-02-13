import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getEntryStats } from "../db/queries.js";
import { toEntryStats } from "../formatters/mappers.js";

export async function handleEntryStats(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("entry_stats", input);

  const stats = await getEntryStats(pool, params.date_from, params.date_to);

  if (stats.total_entries === 0) {
    return "No entries found for the specified date range.";
  }

  return JSON.stringify(toEntryStats(stats), null, 2);
}
