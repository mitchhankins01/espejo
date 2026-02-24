import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import {
  getOuraTrendMetric,
  getOuraSleepDetailForRange,
  getOuraTemperatureData,
} from "../db/queries.js";
import {
  trend,
  rollingAverages,
  detectOutliers,
  sleepDebt,
  sleepRegularity,
  sleepStageRatios,
  dayOfWeekAnalysis,
  correlate,
  mean,
} from "../oura/analysis.js";

function formatDay(d: Date | string): string {
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

async function analyzeSleepQuality(pool: pg.Pool, days: number): Promise<string> {
  const rows = await getOuraSleepDetailForRange(pool, days);
  if (rows.length < 3) return "Insufficient sleep data for analysis (need at least 3 days).";

  const scores = rows.filter((r) => r.score != null).map((r) => r.score as number);
  const durations = rows.filter((r) => r.total_sleep_duration_seconds != null).map((r) => (r.total_sleep_duration_seconds as number) / 3600);
  const trendResult = trend(scores);
  const debt = sleepDebt(durations);
  const dow = dayOfWeekAnalysis(rows.filter((r) => r.score != null).map((r) => ({ date: formatDay(r.day), value: r.score as number })));

  const bedtimes = rows.filter((r) => r.bedtime_start != null).map((r) => (r.bedtime_start as Date).toISOString());
  const waketimes = rows.filter((r) => r.bedtime_end != null).map((r) => (r.bedtime_end as Date).toISOString());
  const regularity = bedtimes.length >= 3 ? sleepRegularity(bedtimes, waketimes) : null;

  const lastRow = rows[rows.length - 1];
  const stages = lastRow.deep_sleep_duration_seconds != null && lastRow.rem_sleep_duration_seconds != null && lastRow.light_sleep_duration_seconds != null
    ? sleepStageRatios(lastRow.deep_sleep_duration_seconds, lastRow.rem_sleep_duration_seconds, lastRow.light_sleep_duration_seconds)
    : null;

  return JSON.stringify({
    type: "sleep_quality",
    days: rows.length,
    trend: { direction: trendResult.direction, significant: trendResult.significant, slope: +trendResult.slope.toFixed(3) },
    average_score: +mean(scores).toFixed(1),
    sleep_debt: { status: debt.status, debt_hours: +debt.debtHours.toFixed(1) },
    regularity: regularity ? { score: +regularity.regularityScore.toFixed(0), status: regularity.status } : null,
    day_of_week: { best: dow.bestDay, worst: dow.worstDay, weekday_avg: +dow.weekdayAverage.toFixed(1), weekend_avg: +dow.weekendAverage.toFixed(1) },
    latest_stages: stages ? { deep: stages.deepStatus, rem: stages.remStatus, deep_pct: +stages.deepPercent.toFixed(1), rem_pct: +stages.remPercent.toFixed(1) } : null,
  }, null, 2);
}

async function analyzeAnomalies(pool: pg.Pool, days: number): Promise<string> {
  const metrics = ["sleep_score", "hrv", "readiness", "activity", "steps"] as const;
  const anomalies: Record<string, Array<{ day: string; value: number }>> = {};

  for (const metric of metrics) {
    const points = await getOuraTrendMetric(pool, metric, days);
    if (points.length < 7) continue;
    const values = points.map((p) => p.value);
    const result = detectOutliers(values);
    const outlierDays = result.outliers.map((o) => ({
      day: formatDay(points[o.index].day),
      value: +o.value.toFixed(1),
    }));
    if (outlierDays.length > 0) anomalies[metric] = outlierDays;
  }

  return JSON.stringify({ type: "anomalies", days, anomalies, total: Object.values(anomalies).flat().length }, null, 2);
}

async function analyzeHrvTrend(pool: pg.Pool, days: number): Promise<string> {
  const points = await getOuraTrendMetric(pool, "hrv", days);
  if (points.length < 3) return "Insufficient HRV data for trend analysis.";

  const values = points.map((p) => p.value);
  const trendResult = trend(values);
  const rolling = rollingAverages(values);
  const dow = dayOfWeekAnalysis(points.map((p) => ({ date: formatDay(p.day), value: p.value })));

  return JSON.stringify({
    type: "hrv_trend",
    days: points.length,
    current: +values[values.length - 1].toFixed(1),
    average: +mean(values).toFixed(1),
    trend: { direction: trendResult.direction, significant: trendResult.significant, slope: +trendResult.slope.toFixed(3) },
    rolling_averages: { "7d": +rolling.day7.value.toFixed(1), "14d": +rolling.day14.value.toFixed(1), "30d": +rolling.day30.value.toFixed(1) },
    day_of_week: { best: dow.bestDay, worst: dow.worstDay },
  }, null, 2);
}

async function analyzeTemperature(pool: pg.Pool, days: number): Promise<string> {
  const points = await getOuraTemperatureData(pool, days);
  if (points.length < 3) return "Insufficient temperature data for analysis.";

  const values = points.map((p) => p.temperature_deviation);
  const trendResult = trend(values);
  const outliers = detectOutliers(values);
  const flaggedDays = outliers.outliers.map((o) => ({
    day: formatDay(points[o.index].day),
    deviation: +o.value.toFixed(2),
  }));

  return JSON.stringify({
    type: "temperature",
    days: points.length,
    average_deviation: +mean(values).toFixed(2),
    trend: { direction: trendResult.direction, significant: trendResult.significant },
    flagged_days: flaggedDays,
  }, null, 2);
}

async function analyzeBestSleep(pool: pg.Pool, days: number): Promise<string> {
  const rows = await getOuraSleepDetailForRange(pool, days);
  if (rows.length < 7) return "Insufficient data for best sleep analysis (need at least 7 days).";

  const steps = rows.filter((r) => r.steps != null && r.score != null).map((r) => r.steps as number);
  const sleepScoresForSteps = rows.filter((r) => r.steps != null && r.score != null).map((r) => r.score as number);

  const stepsCorr = steps.length >= 5 ? correlate(steps, sleepScoresForSteps) : null;
  const dow = dayOfWeekAnalysis(rows.filter((r) => r.score != null).map((r) => ({ date: formatDay(r.day), value: r.score as number })));

  const workoutDayScores = rows.filter((r) => r.workout_count > 0 && r.score != null).map((r) => r.score as number);
  const restDayScores = rows.filter((r) => r.workout_count === 0 && r.score != null).map((r) => r.score as number);

  return JSON.stringify({
    type: "best_sleep",
    days: rows.length,
    day_of_week: { best: dow.bestDay, worst: dow.worstDay, weekday_avg: +dow.weekdayAverage.toFixed(1), weekend_avg: +dow.weekendAverage.toFixed(1) },
    activity_correlation: stepsCorr ? { strength: stepsCorr.strength, direction: stepsCorr.direction, r: +stepsCorr.correlation.toFixed(3) } : null,
    workout_impact: {
      workout_days: { count: workoutDayScores.length, avg_sleep: workoutDayScores.length > 0 ? +mean(workoutDayScores).toFixed(1) : null },
      rest_days: { count: restDayScores.length, avg_sleep: restDayScores.length > 0 ? +mean(restDayScores).toFixed(1) : null },
    },
  }, null, 2);
}

export async function handleGetOuraAnalysis(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("get_oura_analysis", input);

  switch (params.type) {
    case "sleep_quality":
      return analyzeSleepQuality(pool, params.days);
    case "anomalies":
      return analyzeAnomalies(pool, params.days);
    case "hrv_trend":
      return analyzeHrvTrend(pool, params.days);
    case "temperature":
      return analyzeTemperature(pool, params.days);
    case "best_sleep":
      return analyzeBestSleep(pool, params.days);
  }
}
