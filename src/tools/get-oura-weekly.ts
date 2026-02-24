import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraWeeklyRows } from "../db/queries.js";
import { formatOuraWeekly } from "../oura/formatters.js";
import { todayInTimezone } from "../utils/dates.js";

export async function handleGetOuraWeekly(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_weekly", input);
  const endDate = params.end_date ?? todayInTimezone();
  const rows = await getOuraWeeklyRows(pool, endDate);
  return formatOuraWeekly(rows);
}
