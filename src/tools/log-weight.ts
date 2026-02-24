import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { upsertDailyMetric } from "../db/queries.js";
import { todayInTimezone } from "../utils/dates.js";

export async function handleLogWeight(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("log_weight", input);
  const date = params.date ?? todayInTimezone();
  await upsertDailyMetric(pool, date, params.weight_kg);
  return `Logged weight: ${params.weight_kg} kg on ${date}`;
}
