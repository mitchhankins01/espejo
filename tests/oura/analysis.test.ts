import { describe, it, expect } from "vitest";
import {
  mean,
  standardDeviation,
  sampleStandardDeviation,
  quantile,
  min,
  max,
  rollingAverages,
  rollingAverageNumeric,
  trend,
  detectOutliersIQR,
  detectOutliersZScore,
  detectOutliers,
  correlate,
  dispersion,
  gaussianSmooth,
  movingAverage,
  dayOfWeekAnalysis,
  sleepDebt,
  sleepRegularity,
  sleepStageRatios,
  computeSleepScore,
  hrvRecoveryPattern,
  linearTrend,
  rollingAverage,
  pearsonCorrelation,
  percentage,
} from "../../src/oura/analysis.js";

// ============================================================================
// Basic Statistics
// ============================================================================

describe("mean", () => {
  it("computes arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(mean([10])).toBe(10);
  });

  it("returns 0 for empty array", () => {
    expect(mean([])).toBe(0);
  });
});

describe("standardDeviation", () => {
  it("computes population standard deviation", () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 0);
  });

  it("returns 0 for single element", () => {
    expect(standardDeviation([5])).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(standardDeviation([])).toBe(0);
  });
});

describe("sampleStandardDeviation", () => {
  it("computes sample standard deviation", () => {
    const result = sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result).toBeGreaterThan(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]));
  });

  it("returns 0 for fewer than 2 elements", () => {
    expect(sampleStandardDeviation([5])).toBe(0);
    expect(sampleStandardDeviation([])).toBe(0);
  });
});

describe("quantile", () => {
  it("computes Q1, median, Q3", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(data, 0.5)).toBeCloseTo(5.5, 1);
    expect(quantile(data, 0.25)).toBeCloseTo(3.25, 1);
    expect(quantile(data, 0.75)).toBeCloseTo(7.75, 1);
  });

  it("handles single element", () => {
    expect(quantile([42], 0.5)).toBe(42);
  });

  it("returns 0 for empty array", () => {
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe("min", () => {
  it("returns minimum value", () => {
    expect(min([5, 1, 3, 2, 4])).toBe(1);
  });

  it("returns 0 for empty array", () => {
    expect(min([])).toBe(0);
  });
});

describe("max", () => {
  it("returns maximum value", () => {
    expect(max([5, 1, 3, 2, 4])).toBe(5);
  });

  it("returns 0 for empty array", () => {
    expect(max([])).toBe(0);
  });
});

// ============================================================================
// Rolling Averages
// ============================================================================

describe("rollingAverages", () => {
  it("returns day7, day14, day30 windows", () => {
    const values = Array.from({ length: 30 }, (_, i) => 40 + i);
    const result = rollingAverages(values);
    expect(result.day7.window).toBe(7);
    expect(result.day7.count).toBe(7);
    expect(result.day14.window).toBe(14);
    expect(result.day14.count).toBe(14);
    expect(result.day30.window).toBe(30);
    expect(result.day30.count).toBe(30);
    expect(result.day7.value).toBeGreaterThan(result.day30.value);
  });

  it("handles fewer than 7 values", () => {
    const result = rollingAverages([10, 20, 30]);
    expect(result.day7.count).toBe(3);
    expect(result.day7.value).toBeCloseTo(20, 1);
  });
});

describe("rollingAverageNumeric", () => {
  it("computes rolling average for given window", () => {
    const result = rollingAverageNumeric([1, 2, 3, 4, 5], 3);
    expect(result.window).toBe(3);
    expect(result.count).toBe(3);
    expect(result.value).toBe(4); // mean of [3,4,5]
  });
});

// ============================================================================
// Trend Detection
// ============================================================================

describe("trend", () => {
  it("detects improving trend", () => {
    const values = Array.from({ length: 20 }, (_, i) => 50 + i * 2);
    const result = trend(values);
    expect(result.direction).toBe("improving");
    expect(result.slope).toBeGreaterThan(0);
    expect(result.significant).toBe(true);
  });

  it("detects declining trend", () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 - i * 2);
    const result = trend(values);
    expect(result.direction).toBe("declining");
    expect(result.slope).toBeLessThan(0);
  });

  it("detects stable trend for flat data", () => {
    const values = Array(20).fill(50);
    const result = trend(values);
    expect(result.direction).toBe("stable");
    expect(result.slope).toBeCloseTo(0, 5);
  });

  it("returns stable for single value", () => {
    const result = trend([50]);
    expect(result.direction).toBe("stable");
  });

  it("returns stable for empty array", () => {
    const result = trend([]);
    expect(result.direction).toBe("stable");
  });

  it("includes pValue and rSquared", () => {
    const values = Array.from({ length: 20 }, (_, i) => 50 + i);
    const result = trend(values);
    expect(result.pValue).toBeDefined();
    expect(result.rSquared).toBeDefined();
    expect(result.rSquared).toBeGreaterThan(0.9);
  });

  it("computes p-value for noisy data via t-distribution", () => {
    const values = [50, 55, 48, 60, 52, 58, 63, 51, 66, 54, 70, 57, 62, 68, 59, 72, 61, 74, 65, 76];
    const result = trend(values);
    expect(result.pValue).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(1);
    expect(result.rSquared).toBeGreaterThan(0);
    expect(result.rSquared).toBeLessThan(1);
  });

  it("uses normal approximation for large datasets (df > 100)", () => {
    const values = Array.from({ length: 120 }, (_, i) => 50 + i * 0.5 + Math.sin(i) * 5);
    const result = trend(values);
    expect(result.direction).toBe("improving");
    expect(result.pValue).toBeGreaterThanOrEqual(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
  });

  it("triggers incompleteBeta symmetry for weak trends", () => {
    // Nearly-flat noisy data produces a small t-stat, triggering the
    // incompleteBeta symmetry relation (x > (a+1)/(a+b+2))
    const values = [50, 52, 48, 51, 49, 53, 47, 50, 52, 48, 51, 49, 50, 52, 48, 51, 49, 53, 47, 50];
    const result = trend(values);
    expect(result.direction).toBe("stable");
    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.significant).toBe(false);
  });
});

// ============================================================================
// Outlier Detection
// ============================================================================

describe("detectOutliersIQR", () => {
  it("finds IQR outliers", () => {
    const values = [10, 11, 12, 13, 14, 15, 50]; // 50 is outlier
    const result = detectOutliersIQR(values);
    expect(result.outliers.length).toBeGreaterThan(0);
    expect(result.outliers.some((o) => o.value === 50)).toBe(true);
  });

  it("returns empty for uniform data", () => {
    const result = detectOutliersIQR([5, 5, 5, 5, 5]);
    expect(result.outliers).toHaveLength(0);
  });

  it("respects custom multiplier", () => {
    const values = [10, 11, 12, 13, 14, 15, 25];
    const loose = detectOutliersIQR(values, 3);
    const tight = detectOutliersIQR(values, 1);
    expect(tight.outliers.length).toBeGreaterThanOrEqual(loose.outliers.length);
  });

  it("returns no outliers for fewer than 4 values", () => {
    const result = detectOutliersIQR([1, 2, 3]);
    expect(result.outliers).toHaveLength(0);
    expect(result.method).toBe("iqr");
    expect(result.lowerBound).toBe(1);
    expect(result.upperBound).toBe(3);
  });
});

describe("detectOutliersZScore", () => {
  it("finds Z-score outliers", () => {
    const values = [10, 11, 12, 13, 14, 15, 50];
    const result = detectOutliersZScore(values);
    expect(result.outliers.length).toBeGreaterThan(0);
  });

  it("returns empty for uniform data", () => {
    const result = detectOutliersZScore([5, 5, 5, 5, 5]);
    expect(result.outliers).toHaveLength(0);
  });

  it("includes method field", () => {
    const result = detectOutliersZScore([1, 2, 3]);
    expect(result.method).toBe("zscore");
  });

  it("returns no outliers for fewer than 2 values", () => {
    const result = detectOutliersZScore([42]);
    expect(result.outliers).toHaveLength(0);
    expect(result.method).toBe("zscore");
    expect(result.lowerBound).toBe(42);
    expect(result.upperBound).toBe(42);
  });
});

describe("detectOutliers (combined)", () => {
  it("combines IQR and Z-score methods", () => {
    const values = [10, 11, 12, 13, 14, 15, 60];
    const result = detectOutliers(values);
    expect(result.method).toBe("iqr");
    expect(result.outliers.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Correlation
// ============================================================================

describe("correlate", () => {
  it("finds perfect positive correlation", () => {
    const result = correlate([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(result.correlation).toBeCloseTo(1, 5);
    expect(result.strength).toBe("strong");
    expect(result.direction).toBe("positive");
  });

  it("finds perfect negative correlation", () => {
    const result = correlate([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    expect(result.correlation).toBeCloseTo(-1, 5);
    expect(result.direction).toBe("negative");
  });

  it("returns zero for no correlation", () => {
    const result = correlate([1, 2, 3, 4, 5], [5, 5, 5, 5, 5]);
    expect(result.correlation).toBeCloseTo(0, 5);
    expect(result.strength).toBe("none");
  });

  it("returns zero for insufficient data", () => {
    const result = correlate([1], [2]);
    expect(result.correlation).toBe(0);
  });

  it("includes pValue and n", () => {
    const result = correlate([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(result.pValue).toBeDefined();
    expect(result.n).toBe(5);
  });

  it("identifies weak correlation", () => {
    // r ≈ 0.19 (between 0.1 and 0.3)
    const result = correlate(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [5, 6, 4, 7, 3, 8, 5, 4, 7, 6]
    );
    expect(result.strength).toBe("weak");
  });

  it("identifies moderate correlation", () => {
    // r ≈ 0.45 (between 0.3 and 0.5)
    const result = correlate(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [5, 4, 6, 3, 7, 5, 6, 7, 4, 8]
    );
    expect(result.strength).toBe("moderate");
  });
});

// ============================================================================
// Dispersion
// ============================================================================

describe("dispersion", () => {
  it("computes dispersion metrics", () => {
    const result = dispersion([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.mean).toBeCloseTo(5.5, 1);
    expect(result.median).toBeCloseTo(5.5, 1);
    expect(result.min).toBe(1);
    expect(result.max).toBe(10);
    expect(result.range).toBe(9);
    expect(result.iqr).toBeGreaterThan(0);
    expect(result.coefficientOfVariation).toBeGreaterThan(0);
    expect(result.standardDeviation).toBeGreaterThan(0);
  });

  it("handles single value", () => {
    const result = dispersion([5]);
    expect(result.mean).toBe(5);
    expect(result.range).toBe(0);
    expect(result.coefficientOfVariation).toBe(0);
  });

  it("returns zeros for empty array", () => {
    const result = dispersion([]);
    expect(result.mean).toBe(0);
    expect(result.standardDeviation).toBe(0);
    expect(result.coefficientOfVariation).toBe(0);
    expect(result.min).toBe(0);
    expect(result.max).toBe(0);
    expect(result.range).toBe(0);
    expect(result.q1).toBe(0);
    expect(result.median).toBe(0);
    expect(result.q3).toBe(0);
    expect(result.iqr).toBe(0);
  });

  it("returns CV 0 when mean is 0", () => {
    const result = dispersion([0, 0, 0]);
    expect(result.mean).toBe(0);
    expect(result.coefficientOfVariation).toBe(0);
  });
});

// ============================================================================
// Smoothing
// ============================================================================

describe("gaussianSmooth", () => {
  it("smooths values", () => {
    const values = [10, 100, 10, 100, 10];
    const result = gaussianSmooth(values, 1);
    expect(result[2]).toBeLessThan(100);
    expect(result[2]).toBeGreaterThan(10);
    expect(result).toHaveLength(5);
  });

  it("returns empty for empty input", () => {
    expect(gaussianSmooth([], 1)).toEqual([]);
  });
});

describe("movingAverage", () => {
  it("computes moving average with centered window", () => {
    const result = movingAverage([1, 2, 3, 4, 5], 3);
    expect(result).toHaveLength(5);
    expect(result[2]).toBeCloseTo(3, 1);
  });

  it("returns copy for window <= 1", () => {
    const values = [1, 2, 3];
    const result = movingAverage(values, 1);
    expect(result).toEqual([1, 2, 3]);
  });
});

// ============================================================================
// Day of Week Analysis
// ============================================================================

describe("dayOfWeekAnalysis", () => {
  it("finds best and worst day", () => {
    const data = [
      { date: "2025-01-06", value: 90 }, // Monday
      { date: "2025-01-07", value: 60 }, // Tuesday
      { date: "2025-01-08", value: 70 }, // Wednesday
      { date: "2025-01-11", value: 85 }, // Saturday
      { date: "2025-01-12", value: 80 }, // Sunday
    ];
    const result = dayOfWeekAnalysis(data);
    expect(result.bestDay).toBeDefined();
    expect(result.bestDay.day).toBeDefined();
    expect(result.bestDay.average).toBeGreaterThan(0);
    expect(result.worstDay).toBeDefined();
    expect(result.weekdayAverage).toBeGreaterThan(0);
    expect(result.weekendAverage).toBeGreaterThan(0);
    expect(result.dayAverages).toBeDefined();
  });

  it("handles single-day data", () => {
    const result = dayOfWeekAnalysis([{ date: "2025-01-06", value: 80 }]);
    expect(result.bestDay.day).toBe("Monday");
    expect(result.worstDay.day).toBe("Monday");
  });

  it("returns N/A for empty data", () => {
    const result = dayOfWeekAnalysis([]);
    expect(result.bestDay.day).toBe("N/A");
    expect(result.worstDay.day).toBe("N/A");
  });
});

// ============================================================================
// Sleep Analysis
// ============================================================================

describe("sleepDebt", () => {
  it("identifies balanced sleep", () => {
    // 8 hours = 28800 seconds
    const result = sleepDebt([28800, 28800, 28800, 28800, 28800]);
    expect(result.status).toBe("balanced");
    expect(result.debtHours).toBeCloseTo(0, 0);
  });

  it("identifies significant sleep debt", () => {
    // 6 hours = 21600 seconds
    const result = sleepDebt([21600, 21600, 21600, 21600, 21600], 8);
    expect(result.status).toBe("significant_debt");
    expect(result.debtHours).toBeGreaterThan(0);
  });

  it("identifies mild sleep debt", () => {
    // 7.25 hours = 26100 seconds → debt = 0.75 hours (between 0.5 and 1.5)
    const result = sleepDebt([26100, 26100, 26100], 8);
    expect(result.status).toBe("mild_debt");
  });

  it("identifies sleep surplus", () => {
    // 9 hours = 32400 seconds → debt = -1 hour (< -0.5)
    const result = sleepDebt([32400, 32400, 32400], 8);
    expect(result.status).toBe("surplus");
  });

  it("handles empty array", () => {
    const result = sleepDebt([]);
    expect(result.status).toBe("significant_debt");
  });
});

describe("sleepRegularity", () => {
  it("scores consistent sleep schedule", () => {
    const bedtimes = [
      "2025-01-01T22:00:00Z",
      "2025-01-02T22:05:00Z",
      "2025-01-03T22:10:00Z",
    ];
    const waketimes = [
      "2025-01-02T06:00:00Z",
      "2025-01-03T06:05:00Z",
      "2025-01-04T06:10:00Z",
    ];
    const result = sleepRegularity(bedtimes, waketimes);
    expect(result.regularityScore).toBeGreaterThan(80);
    expect(result.status).toBe("very_regular");
    expect(result.bedtimeStd).toBeDefined();
    expect(result.waketimeStd).toBeDefined();
  });

  it("scores irregular sleep schedule", () => {
    const bedtimes = [
      "2025-01-01T20:00:00Z",
      "2025-01-02T02:00:00Z",
      "2025-01-03T23:00:00Z",
    ];
    const waketimes = [
      "2025-01-02T04:00:00Z",
      "2025-01-03T10:00:00Z",
      "2025-01-04T07:00:00Z",
    ];
    const result = sleepRegularity(bedtimes, waketimes);
    expect(result.regularityScore).toBeLessThan(80);
    expect(["irregular", "somewhat_irregular"]).toContain(result.status);
  });

  it("scores regular (60-80) sleep schedule", () => {
    // sampleStd([21,23,22]) = 1.0h, sampleStd([5,7,6]) = 1.0h → avgStd=1.0
    // score = 100 - (1.0-0.5)*66.67 = 66.7 → "regular"
    const bedtimes = [
      "2025-01-01T21:00:00Z",
      "2025-01-02T23:00:00Z",
      "2025-01-03T22:00:00Z",
    ];
    const waketimes = [
      "2025-01-02T05:00:00Z",
      "2025-01-03T07:00:00Z",
      "2025-01-04T06:00:00Z",
    ];
    const result = sleepRegularity(bedtimes, waketimes);
    expect(result.status).toBe("regular");
  });

  it("scores somewhat irregular (40-60) sleep schedule", () => {
    // sampleStd([20.5,23,22]) ≈ 1.26h, sampleStd([4.5,7,6]) ≈ 1.26h → avgStd≈1.26
    // score = 100 - (1.26-0.5)*66.67 = 49.3 → "somewhat_irregular"
    const bedtimes = [
      "2025-01-01T20:30:00Z",
      "2025-01-02T23:00:00Z",
      "2025-01-03T22:00:00Z",
    ];
    const waketimes = [
      "2025-01-02T04:30:00Z",
      "2025-01-03T07:00:00Z",
      "2025-01-04T06:00:00Z",
    ];
    const result = sleepRegularity(bedtimes, waketimes);
    expect(result.status).toBe("somewhat_irregular");
  });
});

describe("sleepStageRatios", () => {
  it("evaluates sleep stage distribution", () => {
    // 1.5h deep, 1.5h REM, 5h light = 8h total
    const result = sleepStageRatios(5400, 5400, 18000);
    expect(result.deepPercent).toBeCloseTo(18.75, 0);
    expect(result.remPercent).toBeCloseTo(18.75, 0);
    expect(result.lightPercent).toBeCloseTo(62.5, 0);
    expect(result.totalSleepSeconds).toBe(28800);
  });

  it("classifies low deep sleep", () => {
    // 15 min deep, 2h REM, 6h light
    const result = sleepStageRatios(900, 7200, 21600);
    expect(result.deepStatus).toBe("low");
  });

  it("classifies low REM sleep", () => {
    // 2h deep, 15min REM, 6h light
    const result = sleepStageRatios(7200, 900, 21600);
    expect(result.remStatus).toBe("low");
  });

  it("returns zeros when all stage durations are zero", () => {
    const result = sleepStageRatios(0, 0, 0);
    expect(result.totalSleepSeconds).toBe(0);
    expect(result.deepPercent).toBe(0);
    expect(result.remPercent).toBe(0);
    expect(result.deepStatus).toBe("low");
    expect(result.remStatus).toBe("low");
  });

  it("classifies excellent REM sleep", () => {
    // 1h deep, 3h REM, 4h light = 8h total → REM 37.5%
    const result = sleepStageRatios(3600, 10800, 14400);
    expect(result.remStatus).toBe("excellent");
  });
});

describe("computeSleepScore", () => {
  it("computes a composite sleep score", () => {
    const result = computeSleepScore(90, 20, 22);
    expect(result.score).toBeGreaterThan(70);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.components).toBeDefined();
    expect(result.components.efficiencyScore).toBeDefined();
    expect(result.components.deepScore).toBeDefined();
    expect(result.components.remScore).toBeDefined();
  });

  it("penalizes low efficiency", () => {
    const low = computeSleepScore(60, 20, 22);
    const high = computeSleepScore(95, 20, 22);
    expect(low.score).toBeLessThan(high.score);
  });

  it("classifies poor sleep score", () => {
    // Very low everything → score < 50
    const result = computeSleepScore(30, 2, 2);
    expect(result.score).toBeLessThan(50);
  });

  it("classifies fair sleep score", () => {
    // Mediocre stats → score 50-70
    const result = computeSleepScore(70, 10, 12);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThan(70);
  });
});

// ============================================================================
// HRV Recovery
// ============================================================================

describe("hrvRecoveryPattern", () => {
  it("analyzes HRV recovery pattern", () => {
    const samples = Array.from({ length: 20 }, (_, i) => 40 + i);
    const result = hrvRecoveryPattern(samples);
    expect(result.firstHalfAvg).toBeDefined();
    expect(result.secondHalfAvg).toBeDefined();
    expect(result.difference).toBeDefined();
    expect(result.differencePercent).toBeDefined();
    expect(["good_recovery", "flat", "declining", "insufficient_data"]).toContain(
      result.pattern
    );
    expect(result.interpretation).toBeDefined();
  });

  it("returns insufficient data for < 4 samples", () => {
    const result = hrvRecoveryPattern([40, 42, 44]);
    expect(result.pattern).toBe("insufficient_data");
  });

  it("detects good recovery pattern (first half higher)", () => {
    // First half avg ~80, second half avg ~50 → differencePercent ~60% > 5%
    const samples = [80, 82, 78, 80, 50, 48, 52, 50];
    const result = hrvRecoveryPattern(samples);
    expect(result.pattern).toBe("good_recovery");
    expect(result.firstHalfAvg).toBeGreaterThan(result.secondHalfAvg);
    expect(result.interpretation).toContain("Good recovery");
  });

  it("detects flat pattern (similar halves)", () => {
    // Both halves avg ~50 → differencePercent ≈ 0%
    const samples = [50, 51, 49, 50, 50, 49, 51, 50];
    const result = hrvRecoveryPattern(samples);
    expect(result.pattern).toBe("flat");
    expect(result.interpretation).toContain("Flat");
  });

  it("filters invalid samples (zeros and non-finite)", () => {
    // [40, 42, 0, 0] → valid = [40, 42] → insufficient_data (< 4)
    const result = hrvRecoveryPattern([40, 42, 0, 0]);
    expect(result.pattern).toBe("insufficient_data");
  });
});

// ============================================================================
// Convenience Aliases
// ============================================================================

describe("linearTrend", () => {
  it("returns improving for upward data", () => {
    const points = Array.from({ length: 20 }, (_, i) => ({
      day: `2025-01-${String(i + 1).padStart(2, "0")}`,
      value: 50 + i * 2,
    }));
    expect(linearTrend(points)).toBe("improving");
  });

  it("returns declining for downward data", () => {
    const points = Array.from({ length: 20 }, (_, i) => ({
      day: `2025-01-${String(i + 1).padStart(2, "0")}`,
      value: 100 - i * 2,
    }));
    expect(linearTrend(points)).toBe("declining");
  });

  it("returns stable for single point", () => {
    expect(linearTrend([{ day: "2025-01-01", value: 50 }])).toBe("stable");
  });
});

describe("rollingAverage", () => {
  it("computes rolling average over MetricPoints", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({
      day: `2025-01-${String(i + 1).padStart(2, "0")}`,
      value: i * 10,
    }));
    const result = rollingAverage(points, 3);
    expect(result).toHaveLength(10);
    expect(result[0].day).toBe("2025-01-01");
    expect(result[0].value).toBe(0); // only 1 element: mean of [0]
    expect(result[2].value).toBeCloseTo(10, 1); // mean of [0, 10, 20]
  });
});

describe("pearsonCorrelation", () => {
  it("returns correlation coefficient", () => {
    expect(pearsonCorrelation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 5);
    expect(pearsonCorrelation([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 5);
  });
});

describe("percentage", () => {
  it("formats as percentage string", () => {
    expect(percentage(1, 4)).toBe("25.0%");
    expect(percentage(3, 10)).toBe("30.0%");
  });

  it("returns 0% for zero total", () => {
    expect(percentage(5, 0)).toBe("0%");
  });
});
