/**
 * HRV recovery pattern analysis.
 */

import { mean } from "./statistics.js";

// ============================================================================
// HRV Recovery Pattern Analysis
// ============================================================================

export interface HrvRecoveryPattern {
  firstHalfAvg: number; // Average HRV in first half of sleep (ms)
  secondHalfAvg: number; // Average HRV in second half of sleep (ms)
  difference: number; // firstHalf - secondHalf
  differencePercent: number; // Percentage difference
  pattern: "good_recovery" | "flat" | "declining" | "insufficient_data";
  interpretation: string;
}

/**
 * Analyze HRV recovery pattern during sleep
 *
 * A healthy recovery pattern shows higher HRV in the first half of the night
 * (parasympathetic dominance during deep sleep) compared to the second half.
 * This indicates the body is recovering well.
 *
 * Patterns:
 * - "good_recovery": First half HRV > second half by 5%+ (healthy)
 * - "flat": HRV roughly equal throughout (neutral)
 * - "declining": Second half HRV > first half (may indicate stress, alcohol, late meals)
 *
 * @param hrvSamples - Array of HRV values during sleep (in chronological order)
 */
export function hrvRecoveryPattern(hrvSamples: number[]): HrvRecoveryPattern {
  // Filter out invalid values
  const validSamples = hrvSamples.filter((v) => v > 0 && isFinite(v));

  if (validSamples.length < 4) {
    return {
      firstHalfAvg: 0,
      secondHalfAvg: 0,
      difference: 0,
      differencePercent: 0,
      pattern: "insufficient_data",
      interpretation: "Not enough HRV samples to analyze recovery pattern (need at least 4).",
    };
  }

  const midpoint = Math.floor(validSamples.length / 2);
  const firstHalf = validSamples.slice(0, midpoint);
  const secondHalf = validSamples.slice(midpoint);

  const firstHalfAvg = mean(firstHalf);
  const secondHalfAvg = mean(secondHalf);
  const difference = firstHalfAvg - secondHalfAvg;
  /* v8 ignore next — validSamples are filtered to v > 0, so secondHalfAvg is always > 0 */
  const differencePercent = secondHalfAvg !== 0 ? (difference / secondHalfAvg) * 100 : 0;

  let pattern: "good_recovery" | "flat" | "declining";
  let interpretation: string;

  if (differencePercent > 5) {
    pattern = "good_recovery";
    interpretation = `Good recovery pattern: HRV was ${Math.abs(differencePercent).toFixed(0)}% higher in the first half of the night, indicating healthy parasympathetic activity during deep sleep.`;
  } else if (differencePercent < -5) {
    pattern = "declining";
    interpretation = `Declining pattern: HRV was ${Math.abs(differencePercent).toFixed(0)}% lower in the first half of the night. This may indicate stress, alcohol consumption, late meals, or incomplete recovery.`;
  } else {
    pattern = "flat";
    interpretation = `Flat pattern: HRV was relatively stable throughout the night. This is neutral - neither strong recovery nor concerning.`;
  }

  return {
    firstHalfAvg: Math.round(firstHalfAvg * 10) / 10,
    secondHalfAvg: Math.round(secondHalfAvg * 10) / 10,
    difference: Math.round(difference * 10) / 10,
    differencePercent: Math.round(differencePercent * 10) / 10,
    pattern,
    interpretation,
  };
}
