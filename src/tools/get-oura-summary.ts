import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraSummaryByDay } from "../db/queries.js";
import { formatOuraSummary } from "../oura/formatters.js";
import { todayInTimezone } from "../utils/dates.js";

export async function handleGetOuraSummary(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_summary", input);
  const date = params.date ?? todayInTimezone();
  const row = await getOuraSummaryByDay(pool, date);
  if (!row) return `No Oura data found for ${date}.`;
  return formatOuraSummary(row);
}
