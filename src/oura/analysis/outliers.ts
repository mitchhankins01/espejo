/**
 * Outlier detection using IQR and Z-score methods.
 */

import { mean, standardDeviation, quantile, min, max } from "./statistics.js";

// ============================================================================
// Outlier Detection
// ============================================================================

export interface OutlierResult {
  outliers: Array<{ index: number; value: number }>;
  lowerBound: number;
  upperBound: number;
  method: "iqr" | "zscore";
}

/**
 * Detect outliers using the IQR method
 * Values outside Q1 - 1.5*IQR or Q3 + 1.5*IQR are outliers
 *
 * @param values - Array of numeric values
 * @param multiplier - IQR multiplier (default 1.5, use 3 for extreme outliers)
 */
export function detectOutliersIQR(values: number[], multiplier = 1.5): OutlierResult {
  if (values.length < 4) {
    return {
      outliers: [],
      lowerBound: min(values),
      upperBound: max(values),
      method: "iqr",
    };
  }

  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;

  const lowerBound = q1 - multiplier * iqr;
  const upperBound = q3 + multiplier * iqr;

  const outliers: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (value < lowerBound || value > upperBound) {
      outliers.push({ index, value });
    }
  });

  return { outliers, lowerBound, upperBound, method: "iqr" };
}

/**
 * Detect outliers using Z-score method
 * Values with |z| > threshold are outliers
 *
 * @param values - Array of numeric values
 * @param threshold - Z-score threshold (default 2)
 */
export function detectOutliersZScore(values: number[], threshold = 2): OutlierResult {
  if (values.length < 2) {
    return {
      outliers: [],
      lowerBound: min(values),
      upperBound: max(values),
      method: "zscore",
    };
  }

  const avg = mean(values);
  const std = standardDeviation(values);

  if (std === 0) {
    return {
      outliers: [],
      lowerBound: avg,
      upperBound: avg,
      method: "zscore",
    };
  }

  const lowerBound = avg - threshold * std;
  const upperBound = avg + threshold * std;

  const outliers: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    const zScore = Math.abs((value - avg) / std);
    if (zScore > threshold) {
      outliers.push({ index, value });
    }
  });

  return { outliers, lowerBound, upperBound, method: "zscore" };
}

/**
 * Combined outlier detection using both IQR and Z-score
 * Returns outliers flagged by both methods (more conservative)
 */
export function detectOutliers(
  values: number[],
  options: { iqrMultiplier?: number; zScoreThreshold?: number } = {}
): OutlierResult {
  const { iqrMultiplier = 1.5, zScoreThreshold = 2 } = options;

  const iqrResult = detectOutliersIQR(values, iqrMultiplier);
  const zResult = detectOutliersZScore(values, zScoreThreshold);

  // Find outliers flagged by both methods
  const iqrIndices = new Set(iqrResult.outliers.map((o) => o.index));
  const combinedOutliers = zResult.outliers.filter((o) => iqrIndices.has(o.index));

  return {
    outliers: combinedOutliers,
    lowerBound: Math.max(iqrResult.lowerBound, zResult.lowerBound),
    upperBound: Math.min(iqrResult.upperBound, zResult.upperBound),
    method: "iqr", // Combined uses both, but we mark as IQR for primary
  };
}
