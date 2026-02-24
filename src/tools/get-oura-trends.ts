import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraTrendMetric } from "../db/queries.js";
import { linearTrend, rollingAverage } from "../oura/analysis.js";

export async function handleGetOuraTrends(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_trends", input);
  const points = await getOuraTrendMetric(pool, params.metric, params.days);
  if (points.length === 0) return "No Oura trend data found for the requested range.";
  const normalized = points.map((p) => ({ day: p.day.toISOString().slice(0, 10), value: p.value }));
  const trend = linearTrend(normalized);
  const roll = rollingAverage(normalized, Math.min(7, normalized.length));
  return JSON.stringify({ metric: params.metric, days: params.days, trend, points: normalized, rolling_average: roll }, null, 2);
}
