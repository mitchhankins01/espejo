/**
 * Correlation analysis, dispersion metrics, smoothing, and day-of-week patterns.
 */

import { mean, standardDeviation, min, max, quantile } from "./statistics.js";
import { tDistributionPValue } from "./trends.js";

// ============================================================================
// Correlation Analysis
// ============================================================================

export interface CorrelationResult {
  correlation: number; // Pearson correlation coefficient (-1 to 1)
  pValue: number; // Statistical significance
  significant: boolean; // p < 0.05
  strength: "none" | "weak" | "moderate" | "strong";
  direction: "positive" | "negative" | "none";
  n: number; // Sample size
}

/**
 * Calculate Pearson correlation between two arrays
 * Includes p-value for statistical significance
 *
 * @param x - First array of values
 * @param y - Second array of values
 */
export function correlate(x: number[], y: number[]): CorrelationResult {
  const n = Math.min(x.length, y.length);

  if (n < 3) {
    return {
      correlation: 0,
      pValue: 1,
      significant: false,
      strength: "none",
      direction: "none",
      n,
    };
  }

  // Trim to same length
  const xTrim = x.slice(0, n);
  const yTrim = y.slice(0, n);

  const xMean = mean(xTrim);
  const yMean = mean(yTrim);

  let numerator = 0;
  let xSS = 0;
  let ySS = 0;

  for (let i = 0; i < n; i++) {
    const xDiff = xTrim[i] - xMean;
    const yDiff = yTrim[i] - yMean;
    numerator += xDiff * yDiff;
    xSS += xDiff * xDiff;
    ySS += yDiff * yDiff;
  }

  const denom = Math.sqrt(xSS * ySS);
  const r = denom !== 0 ? numerator / denom : 0;

  // Calculate p-value using t-distribution
  // For perfect correlation (r = +/-1), p-value is essentially 0
  let pValue: number;
  if (Math.abs(r) >= 0.9999) {
    pValue = 0;
  } else {
    const tStat = (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r);
    pValue = tDistributionPValue(Math.abs(tStat), n - 2);
  }

  // Determine strength
  const absR = Math.abs(r);
  let strength: "none" | "weak" | "moderate" | "strong";
  if (absR < 0.1) strength = "none";
  else if (absR < 0.3) strength = "weak";
  else if (absR < 0.5) strength = "moderate";
  else strength = "strong";

  return {
    correlation: r,
    pValue,
    significant: pValue < 0.05,
    strength,
    direction: r > 0.1 ? "positive" : r < -0.1 ? "negative" : "none",
    n,
  };
}

// ============================================================================
// Dispersion Analysis
// ============================================================================

export interface DispersionResult {
  mean: number;
  standardDeviation: number;
  coefficientOfVariation: number; // CV = std/mean (as percentage)
  min: number;
  max: number;
  range: number;
  q1: number;
  median: number;
  q3: number;
  iqr: number;
}

/**
 * Calculate dispersion/variability metrics
 * Coefficient of variation (CV) is useful for comparing variability across different metrics
 *
 * @param values - Array of numeric values
 */
export function dispersion(values: number[]): DispersionResult {
  if (values.length === 0) {
    return {
      mean: 0,
      standardDeviation: 0,
      coefficientOfVariation: 0,
      min: 0,
      max: 0,
      range: 0,
      q1: 0,
      median: 0,
      q3: 0,
      iqr: 0,
    };
  }

  const avg = mean(values);
  const std = standardDeviation(values);
  const minVal = min(values);
  const maxVal = max(values);
  const q1 = quantile(values, 0.25);
  const median = quantile(values, 0.5);
  const q3 = quantile(values, 0.75);

  return {
    mean: avg,
    standardDeviation: std,
    coefficientOfVariation: avg !== 0 ? (std / avg) * 100 : 0,
    min: minVal,
    max: maxVal,
    range: maxVal - minVal,
    q1,
    median,
    q3,
    iqr: q3 - q1,
  };
}

// ============================================================================
// Smoothing (for visualization)
// ============================================================================

/**
 * Apply Gaussian smoothing to a time series
 * Useful for visualization to reduce noise
 *
 * @param values - Array of numeric values
 * @param sigma - Standard deviation of Gaussian kernel (higher = smoother)
 */
export function gaussianSmooth(values: number[], sigma: number): number[] {
  if (values.length === 0 || sigma <= 0) return [...values];

  // Calculate kernel size (3 sigma each side)
  const kernelRadius = Math.ceil(sigma * 3);
  const kernelSize = kernelRadius * 2 + 1;

  // Generate Gaussian kernel
  const kernel: number[] = [];
  let kernelSum = 0;
  for (let i = -kernelRadius; i <= kernelRadius; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(weight);
    kernelSum += weight;
  }
  // Normalize kernel
  const normalizedKernel = kernel.map((k) => k / kernelSum);

  // Apply convolution with edge handling (reflect)
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let smoothedValue = 0;
    for (let j = 0; j < kernelSize; j++) {
      const dataIndex = i + j - kernelRadius;
      // Reflect at edges
      const clampedIndex = Math.max(0, Math.min(values.length - 1, dataIndex));
      smoothedValue += values[clampedIndex] * normalizedKernel[j];
    }
    result.push(smoothedValue);
  }

  return result;
}

/**
 * Simple moving average smoothing
 *
 * @param values - Array of numeric values
 * @param window - Window size for averaging
 */
export function movingAverage(values: number[], window: number): number[] {
  if (values.length === 0 || window <= 1) return [...values];

  const halfWindow = Math.floor(window / 2);
  const result: number[] = [];

  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(values.length, i + halfWindow + 1);
    const slice = values.slice(start, end);
    result.push(mean(slice));
  }

  return result;
}

// ============================================================================
// Day-of-Week Analysis
// ============================================================================

export interface DayOfWeekResult {
  dayAverages: Record<string, number>;
  dayCount: Record<string, number>;
  bestDay: { day: string; average: number };
  worstDay: { day: string; average: number };
  weekdayAverage: number;
  weekendAverage: number;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Analyze patterns by day of week
 *
 * @param data - Array of { date: string, value: number } objects
 */
export function dayOfWeekAnalysis(
  data: Array<{ date: string; value: number }>
): DayOfWeekResult {
  const dayTotals: Record<string, number[]> = {
    Sunday: [],
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: [],
    Saturday: [],
  };

  for (const { date, value } of data) {
    const dayIndex = new Date(date).getDay();
    const dayName = DAY_NAMES[dayIndex];
    dayTotals[dayName].push(value);
  }

  const dayAverages: Record<string, number> = {};
  const dayCount: Record<string, number> = {};
  let bestDay = { day: "", average: -Infinity };
  let worstDay = { day: "", average: Infinity };

  for (const day of DAY_NAMES) {
    const avg = mean(dayTotals[day]);
    dayAverages[day] = avg;
    dayCount[day] = dayTotals[day].length;

    if (dayTotals[day].length > 0) {
      if (avg > bestDay.average) {
        bestDay = { day, average: avg };
      }
      if (avg < worstDay.average) {
        worstDay = { day, average: avg };
      }
    }
  }

  // Weekday vs weekend
  const weekdayValues = [
    ...dayTotals.Monday,
    ...dayTotals.Tuesday,
    ...dayTotals.Wednesday,
    ...dayTotals.Thursday,
    ...dayTotals.Friday,
  ];
  const weekendValues = [...dayTotals.Saturday, ...dayTotals.Sunday];

  return {
    dayAverages,
    dayCount,
    bestDay: bestDay.day ? bestDay : { day: "N/A", average: 0 },
    worstDay: worstDay.day ? worstDay : { day: "N/A", average: 0 },
    weekdayAverage: mean(weekdayValues),
    weekendAverage: mean(weekendValues),
  };
}

/**
 * Simple Pearson correlation coefficient between two arrays.
 * Convenience wrapper around correlate() that returns just the coefficient.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  return correlate(x, y).correlation;
}
