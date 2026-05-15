import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { listWeights } from "../db/queries/weights.js";
import { todayInTimezone, daysAgoInTimezone } from "../utils/dates.js";

export async function handleGetRecentWeights(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_recent_weights", input);
  const to = todayInTimezone();
  const from = daysAgoInTimezone(params.days - 1);

  const { rows } = await listWeights(pool, { from, to, limit: 200 });
  if (rows.length === 0) {
    return `No weight measurements between ${from} and ${to}.`;
  }

  const lines = rows.map((r) => {
    const dateStr =
      r.date instanceof Date
        ? r.date.toISOString().slice(0, 10)
        : String(r.date);
    return `${dateStr}: ${Number(r.weight_kg).toFixed(1)} kg`;
  });

  return `${rows.length} measurement${rows.length === 1 ? "" : "s"} from ${from} to ${to} (newest first):\n\n${lines.join("\n")}`;
}
