import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getOuraTrendMetric } from "../db/queries.js";
import { linearTrend, rollingAverage } from "../oura/analysis.js";

export async function handleGetOuraAnalysis(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_analysis", input);
  const metricMap = {
    sleep_quality: "sleep_score",
    anomalies: "sleep_score",
    hrv_trend: "hrv",
    temperature: "readiness",
    best_sleep: "sleep_duration",
  } as const;
  const metric = metricMap[params.type];
  const points = await getOuraTrendMetric(pool, metric, params.days);
  const normalized = points.map((p) => ({ day: p.day.toISOString().slice(0, 10), value: p.value }));
  return JSON.stringify({ type: params.type, trend: linearTrend(normalized), rolling: rollingAverage(normalized) }, null, 2);
}
