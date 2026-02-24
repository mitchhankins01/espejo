import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraTrendMetric } from "../db/queries.js";
import { pearsonCorrelation } from "../oura/analysis.js";

export async function handleOuraCorrelate(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("oura_correlate", input);
  const [left, right] = await Promise.all([
    getOuraTrendMetric(pool, params.metric_a, params.days),
    getOuraTrendMetric(pool, params.metric_b, params.days),
  ]);
  const mapB = new Map(right.map((r) => [r.day.toISOString().slice(0, 10), r.value]));
  const paired = left
    .map((a) => ({ x: a.value, y: mapB.get(a.day.toISOString().slice(0, 10)) }))
    .filter((p): p is { x: number; y: number } => typeof p.y === "number");
  const r = pearsonCorrelation(
    paired.map((p) => p.x),
    paired.map((p) => p.y)
  );
  const strength = Math.abs(r) > 0.7 ? "strong" : Math.abs(r) > 0.4 ? "moderate" : "weak";
  return JSON.stringify({ metric_a: params.metric_a, metric_b: params.metric_b, days: params.days, correlation: r, strength, sample_size: paired.length }, null, 2);
}
