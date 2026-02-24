import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraTrendMetricForRange } from "../db/queries.js";

function avg(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export async function handleOuraComparePeriods(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("oura_compare_periods", input);
  const metrics = ["sleep_score", "readiness", "activity", "hrv", "steps", "sleep_duration"] as const;

  const startDate = params.from_a < params.from_b ? params.from_a : params.from_b;
  const endDate = params.to_a > params.to_b ? params.to_a : params.to_b;

  const allRows = await Promise.all(
    metrics.map((metric) => getOuraTrendMetricForRange(pool, metric, startDate, endDate))
  );

  const result: Record<string, { period_a: number; period_b: number; change_percent: number }> = {};
  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i];
    const rows = allRows[i];
    const a = rows
      .filter((r) => {
        const d = r.day.toISOString().slice(0, 10);
        return d >= params.from_a && d <= params.to_a;
      })
      .map((r) => r.value);
    const b = rows
      .filter((r) => {
        const d = r.day.toISOString().slice(0, 10);
        return d >= params.from_b && d <= params.to_b;
      })
      .map((r) => r.value);
    const avga = avg(a);
    const avgb = avg(b);
    result[metric] = { period_a: avga, period_b: avgb, change_percent: avga === 0 ? 0 : ((avgb - avga) / avga) * 100 };
  }
  return JSON.stringify(result, null, 2);
}
