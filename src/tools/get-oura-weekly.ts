import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { getOuraWeeklyRows } from "../db/queries.js";
import { formatOuraWeekly } from "../oura/formatters.js";

function todayInTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function handleGetOuraWeekly(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_weekly", input);
  const endDate = params.end_date ?? todayInTimezone();
  const rows = await getOuraWeeklyRows(pool, endDate);
  return formatOuraWeekly(rows);
}
