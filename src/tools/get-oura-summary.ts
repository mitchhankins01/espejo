import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";
import { getOuraSummaryByDay } from "../db/queries.js";
import { formatOuraSummary } from "../oura/formatters.js";

function todayInTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function handleGetOuraSummary(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_summary", input);
  const date = params.date ?? todayInTimezone();
  const row = await getOuraSummaryByDay(pool, date);
  if (!row) return `No Oura data found for ${date}.`;
  return formatOuraSummary(row);
}
