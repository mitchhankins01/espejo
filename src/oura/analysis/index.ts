/**
 * Statistical analysis utilities for Oura data
 * Ported from oura-ring-mcp. Inspired by Stanford Wearipedia notebook patterns.
 * All pure functions, no external imports.
 */

export {
  mean,
  standardDeviation,
  sampleStandardDeviation,
  quantile,
  min,
  max,
} from "./statistics.js";

export type { RollingAverageResult } from "./trends.js";
export {
  rollingAverages,
  rollingAverageNumeric,
  trend,
  tDistributionPValue,
  linearTrend,
  rollingAverage,
  percentage,
} from "./trends.js";
export type { TrendResult, MetricPoint } from "./trends.js";

export type { OutlierResult } from "./outliers.js";
export {
  detectOutliersIQR,
  detectOutliersZScore,
  detectOutliers,
} from "./outliers.js";

export type { CorrelationResult, DispersionResult, DayOfWeekResult } from "./correlations.js";
export {
  correlate,
  dispersion,
  gaussianSmooth,
  movingAverage,
  dayOfWeekAnalysis,
  pearsonCorrelation,
} from "./correlations.js";

export type {
  SleepDebtResult,
  SleepRegularityResult,
  SleepStageRatios,
  ComputedSleepScore,
} from "./sleep.js";
export {
  sleepDebt,
  sleepRegularity,
  sleepStageRatios,
  computeSleepScore,
} from "./sleep.js";

export type { HrvRecoveryPattern } from "./hrv.js";
export { hrvRecoveryPattern } from "./hrv.js";
