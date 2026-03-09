/**
 * Rolling averages, trend detection (linear regression), and MetricPoint convenience aliases.
 */

import { mean, standardDeviation } from "./statistics.js";

// ============================================================================
// Rolling Averages
// ============================================================================

export interface RollingAverageResult {
  value: number;
  window: number;
  count: number; // actual data points in window (may be less if insufficient data)
}

/**
 * Calculate rolling averages for multiple windows
 * Returns averages for 7-day, 14-day, and 30-day windows
 *
 * @param values - Array of values (most recent last)
 * @returns Object with rolling averages for each window size
 */
export function rollingAverages(values: number[]): {
  day7: RollingAverageResult;
  day14: RollingAverageResult;
  day30: RollingAverageResult;
} {
  const calc = (window: number): RollingAverageResult => {
    const slice = values.slice(-window);
    return {
      value: mean(slice),
      window,
      count: slice.length,
    };
  };

  return {
    day7: calc(7),
    day14: calc(14),
    day30: calc(30),
  };
}

/**
 * Calculate a single rolling average for a custom window
 */
export function rollingAverageNumeric(values: number[], window: number): RollingAverageResult {
  const slice = values.slice(-window);
  return {
    value: mean(slice),
    window,
    count: slice.length,
  };
}

// ============================================================================
// Trend Detection (Linear Regression)
// ============================================================================

export interface TrendResult {
  slope: number; // change per day
  intercept: number;
  rValue: number; // correlation coefficient (-1 to 1)
  rSquared: number; // coefficient of determination (0 to 1)
  pValue: number; // statistical significance
  standardError: number;
  direction: "improving" | "declining" | "stable";
  significant: boolean; // p < 0.05
}

/**
 * Calculate linear regression trend
 * Uses least squares method, returns slope, r-value, and p-value
 *
 * @param values - Array of values (index = x, value = y)
 * @returns Trend analysis result
 */
export function trend(values: number[]): TrendResult {
  if (values.length < 2) {
    return {
      slope: 0,
      intercept: values[0] || 0,
      rValue: 0,
      rSquared: 0,
      pValue: 1,
      standardError: 0,
      direction: "stable",
      significant: false,
    };
  }

  const n = values.length;
  const x = values.map((_, i) => i);
  const y = values;

  const xMean = mean(x);
  const yMean = mean(y);

  // Calculate slope and intercept
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (x[i] - xMean) * (y[i] - yMean);
    denominator += Math.pow(x[i] - xMean, 2);
  }

  /* v8 ignore next — x is always [0..n-1], so denominator (sum of squared deviations) is always > 0 */
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;

  // Calculate R-value (correlation coefficient)
  const xStd = standardDeviation(x);
  const yStd = standardDeviation(y);
  const rValue = xStd !== 0 && yStd !== 0 ? numerator / (n * xStd * yStd) : 0;
  const rSquared = rValue * rValue;

  // Calculate standard error of the slope
  const predicted = x.map((xi) => slope * xi + intercept);
  const residuals = y.map((yi, i) => yi - predicted[i]);
  const residualSS = residuals.reduce((sum, r) => sum + r * r, 0);
  const residualStd = n > 2 ? Math.sqrt(residualSS / (n - 2)) : 0;
  /* v8 ignore next — same as above: denominator is always > 0 for sequential x indices */
  const standardError = denominator !== 0 ? residualStd / Math.sqrt(denominator) : 0;

  // Calculate p-value using t-distribution approximation
  // For perfect linear relationship (r = +/-1), p-value is essentially 0
  let pValue: number;
  if (Math.abs(rValue) >= 0.9999) {
    pValue = 0;
  } else if (standardError === 0) {
    pValue = 1;
  } else {
    const tStat = Math.abs(slope / standardError);
    pValue = tDistributionPValue(tStat, n - 2);
  }

  // Determine direction (consider slope relative to mean)
  /* v8 ignore next — yMean is 0 only when all values are 0, which is unrealistic for health metrics */
  const slopePercentOfMean = yMean !== 0 ? (slope / yMean) * 100 : 0;
  let direction: "improving" | "declining" | "stable";
  if (Math.abs(slopePercentOfMean) < 0.5) {
    direction = "stable";
  } else {
    direction = slope > 0 ? "improving" : "declining";
  }

  return {
    slope,
    intercept,
    rValue,
    rSquared,
    pValue,
    standardError,
    direction,
    significant: pValue < 0.05,
  };
}

/**
 * Approximate p-value for two-tailed t-test
 * Uses a rational approximation that's accurate for df > 1
 */
export function tDistributionPValue(t: number, df: number): number {
  /* v8 ignore next 2 — df is always n-2 where n≥2 and t is always > 0 from callers */
  if (df <= 0) return 1;
  if (t === 0) return 1;

  // Use approximation based on regularized incomplete beta function
  const x = df / (df + t * t);

  // For large df, use normal approximation
  if (df > 100) {
    const z = Math.abs(t);
    // Standard normal CDF approximation
    const p = 0.5 * (1 + erf(z / Math.sqrt(2)));
    return 2 * (1 - p);
  }

  // Regularized incomplete beta function approximation
  const a = df / 2;
  const b = 0.5;
  const beta = incompleteBeta(x, a, b);

  return beta;
}

/**
 * Error function approximation (Horner form)
 */
function erf(x: number): number {
  /* v8 ignore next — only called with Math.abs(t)/sqrt(2), always positive */
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

/**
 * Incomplete beta function approximation
 * Uses continued fraction expansion
 */
function incompleteBeta(x: number, a: number, b: number): number {
  /* v8 ignore next 2 — x = df/(df+t²), always 0 < x < 1 for positive t and df */
  if (x === 0) return 0;
  if (x === 1) return 1;

  // Use the symmetry relation if needed for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Lentz's algorithm for continued fraction
  const eps = 1e-10;
  const maxIter = 200;

  let f = 1;
  let c = 1;
  let d = 0;

  for (let m = 0; m <= maxIter; m++) {
    const m2 = 2 * m;

    // Even step
    const aa_even =
      m === 0 ? 1 : (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));

    d = 1 + aa_even * d;
    /* v8 ignore next — numerical stability guard for continued fraction convergence */
    if (Math.abs(d) < eps) d = eps;
    d = 1 / d;

    c = 1 + aa_even / c;
    /* v8 ignore next — numerical stability guard for continued fraction convergence */
    if (Math.abs(c) < eps) c = eps;

    f *= c * d;

    // Odd step
    const aa_odd = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));

    d = 1 + aa_odd * d;
    /* v8 ignore next — numerical stability guard for continued fraction convergence */
    if (Math.abs(d) < eps) d = eps;
    d = 1 / d;

    c = 1 + aa_odd / c;
    /* v8 ignore next — numerical stability guard for continued fraction convergence */
    if (Math.abs(c) < eps) c = eps;

    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1) < eps) break;
  }

  return front * f;
}

/**
 * Log gamma function approximation (Lanczos)
 */
function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];

  /* v8 ignore next 3 — z is always >= 0.5 when called from tDistributionPValue (a=df/2≥0.5, b=0.5, a+b≥1) */
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;

  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ============================================================================
// Convenience Aliases (MetricPoint-based API for espejo integration)
// ============================================================================

/**
 * A { day, value } pair for time-series data.
 */
export type MetricPoint = { day: string; value: number };

/**
 * Simple trend direction from MetricPoint data.
 * Uses proper linear regression internally via trend().
 */
export function linearTrend(points: MetricPoint[]): "improving" | "stable" | "declining" {
  if (points.length < 2) return "stable";
  const result = trend(points.map((p) => p.value));
  return result.direction;
}

/**
 * Trailing-window rolling average over MetricPoint data.
 * Returns a new MetricPoint[] with smoothed values.
 */
export function rollingAverage(points: MetricPoint[], window = 7): MetricPoint[] {
  return points.map((point, idx) => {
    const start = Math.max(0, idx - window + 1);
    const slice = points.slice(start, idx + 1);
    const value = slice.reduce((sum, p) => sum + p.value, 0) / slice.length;
    return { day: point.day, value };
  });
}

/**
 * Helper: format a number as a percentage string.
 */
export function percentage(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}
