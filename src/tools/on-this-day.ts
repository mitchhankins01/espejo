import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getEntriesOnThisDay } from "../db/queries.js";
import { formatEntryList } from "../formatters/entry.js";

export async function handleOnThisDay(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("on_this_day", input);

  const [monthStr, dayStr] = params.month_day.split("-");
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  const entries = await getEntriesOnThisDay(pool, month, day);

  if (entries.length === 0) {
    return `No entries found for ${params.month_day} across any year.`;
  }

  const years = entries.map((e) =>
    new Date(e.created_at).getFullYear().toString()
  );
  const header = `Found ${entries.length} entr${entries.length > 1 ? "ies" : "y"} on ${params.month_day} across ${[...new Set(years)].length} year${[...new Set(years)].length > 1 ? "s" : ""}:\n\n`;

  return header + formatEntryList(entries);
}
