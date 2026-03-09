/**
 * Sleep-specific metrics: debt, regularity, stage ratios, computed sleep score.
 */

import { mean, sampleStandardDeviation } from "./statistics.js";

// ============================================================================
// Sleep-Specific Metrics
// ============================================================================

export interface SleepDebtResult {
  targetHours: number;
  actualHours: number;
  debtHours: number; // negative = sleep surplus
  debtPercentage: number;
  status: "surplus" | "balanced" | "mild_debt" | "significant_debt";
}

/**
 * Calculate sleep debt against a target (default 8 hours)
 *
 * @param sleepDurations - Array of sleep durations in seconds
 * @param targetHours - Target sleep hours per night (default 8)
 */
export function sleepDebt(sleepDurations: number[], targetHours = 8): SleepDebtResult {
  const actualHours = mean(sleepDurations) / 3600;
  const debtHours = targetHours - actualHours;
  const debtPercentage = ((targetHours - actualHours) / targetHours) * 100;

  let status: "surplus" | "balanced" | "mild_debt" | "significant_debt";
  if (debtHours <= -0.5) status = "surplus";
  else if (debtHours < 0.5) status = "balanced";
  else if (debtHours < 1.5) status = "mild_debt";
  else status = "significant_debt";

  return {
    targetHours,
    actualHours,
    debtHours,
    debtPercentage,
    status,
  };
}

export interface SleepRegularityResult {
  bedtimeStd: number; // hours
  waketimeStd: number; // hours
  regularityScore: number; // 0-100, higher = more regular
  status: "very_regular" | "regular" | "somewhat_irregular" | "irregular";
}

/**
 * Calculate sleep regularity based on consistency of bed/wake times
 *
 * @param bedtimes - Array of bedtime timestamps (ISO strings)
 * @param waketimes - Array of waketime timestamps (ISO strings)
 */
export function sleepRegularity(bedtimes: string[], waketimes: string[]): SleepRegularityResult {
  const extractHour = (iso: string): number => {
    const date = new Date(iso);
    let hour = date.getHours() + date.getMinutes() / 60;
    // Handle overnight (if bedtime is before midnight, adjust)
    if (hour < 12) hour += 24; // treat early morning as previous night
    return hour;
  };

  const bedtimeHours = bedtimes.map(extractHour);
  const waketimeHours = waketimes.map((iso) => {
    const date = new Date(iso);
    return date.getHours() + date.getMinutes() / 60;
  });

  const bedtimeStd = sampleStandardDeviation(bedtimeHours);
  const waketimeStd = sampleStandardDeviation(waketimeHours);

  // Score: inverse of combined variability (lower variability = higher score)
  // 0.5 hours std = 100 score, 2 hours std = 0 score
  const avgStd = (bedtimeStd + waketimeStd) / 2;
  const regularityScore = Math.max(0, Math.min(100, 100 - (avgStd - 0.5) * (100 / 1.5)));

  let status: "very_regular" | "regular" | "somewhat_irregular" | "irregular";
  if (regularityScore >= 80) status = "very_regular";
  else if (regularityScore >= 60) status = "regular";
  else if (regularityScore >= 40) status = "somewhat_irregular";
  else status = "irregular";

  return {
    bedtimeStd,
    waketimeStd,
    regularityScore,
    status,
  };
}

// ============================================================================
// Sleep Stage Analysis (Derived Metrics)
// ============================================================================

export interface SleepStageRatios {
  deepRatio: number; // 0-1, percentage as decimal
  remRatio: number;
  lightRatio: number;
  deepPercent: number; // 0-100
  remPercent: number;
  lightPercent: number;
  deepStatus: "low" | "normal" | "good" | "excellent";
  remStatus: "low" | "normal" | "good" | "excellent";
  totalSleepSeconds: number;
}

/**
 * Calculate sleep stage ratios from duration data
 * Ratios are based on total sleep duration (not time in bed), matching Oura app behavior.
 *
 * Target ranges (per Oura and sleep science):
 * - Deep sleep: 15-20% (excellent: >20%)
 * - REM sleep: 20-25% (excellent: >25%)
 * - Light sleep: remainder (~55-65%)
 *
 * @param deepSeconds - Deep sleep duration in seconds
 * @param remSeconds - REM sleep duration in seconds
 * @param lightSeconds - Light sleep duration in seconds
 */
export function sleepStageRatios(
  deepSeconds: number,
  remSeconds: number,
  lightSeconds: number
): SleepStageRatios {
  const totalSleepSeconds = deepSeconds + remSeconds + lightSeconds;

  if (totalSleepSeconds === 0) {
    return {
      deepRatio: 0,
      remRatio: 0,
      lightRatio: 0,
      deepPercent: 0,
      remPercent: 0,
      lightPercent: 0,
      deepStatus: "low",
      remStatus: "low",
      totalSleepSeconds: 0,
    };
  }

  const deepRatio = deepSeconds / totalSleepSeconds;
  const remRatio = remSeconds / totalSleepSeconds;
  const lightRatio = lightSeconds / totalSleepSeconds;

  const deepPercent = deepRatio * 100;
  const remPercent = remRatio * 100;
  const lightPercent = lightRatio * 100;

  // Deep sleep status (target: 15-20%, excellent: >20%)
  let deepStatus: "low" | "normal" | "good" | "excellent";
  if (deepPercent < 10) deepStatus = "low";
  else if (deepPercent < 15) deepStatus = "normal";
  else if (deepPercent < 20) deepStatus = "good";
  else deepStatus = "excellent";

  // REM status (target: 20-25%, excellent: >25%)
  let remStatus: "low" | "normal" | "good" | "excellent";
  if (remPercent < 15) remStatus = "low";
  else if (remPercent < 20) remStatus = "normal";
  else if (remPercent < 25) remStatus = "good";
  else remStatus = "excellent";

  return {
    deepRatio,
    remRatio,
    lightRatio,
    deepPercent,
    remPercent,
    lightPercent,
    deepStatus,
    remStatus,
    totalSleepSeconds,
  };
}

export interface ComputedSleepScore {
  score: number; // 0-100
  components: {
    efficiencyScore: number; // contribution from efficiency
    deepScore: number; // contribution from deep sleep %
    remScore: number; // contribution from REM %
  };
  interpretation: "poor" | "fair" | "good" | "excellent";
}

/**
 * Compute a sleep quality score from key metrics
 * Formula inspired by sleep research: weighted combination of efficiency, deep%, and REM%
 *
 * Weights:
 * - Efficiency: 50% (most important - actually sleeping while in bed)
 * - Deep sleep %: 30% (restorative sleep)
 * - REM sleep %: 20% (cognitive recovery, memory consolidation)
 *
 * @param efficiency - Sleep efficiency as percentage (0-100)
 * @param deepPercent - Deep sleep as percentage of total sleep (0-100)
 * @param remPercent - REM sleep as percentage of total sleep (0-100)
 */
export function computeSleepScore(
  efficiency: number,
  deepPercent: number,
  remPercent: number
): ComputedSleepScore {
  // Normalize inputs to 0-100 scale with reasonable targets
  // Efficiency: direct use (already 0-100, target is 85-95%)
  const efficiencyScore = Math.min(100, efficiency);

  // Deep sleep: target is 15-20%, scale so 20% = 100 points
  // 0% = 0, 10% = 50, 20%+ = 100
  const deepScore = Math.min(100, (deepPercent / 20) * 100);

  // REM sleep: target is 20-25%, scale so 25% = 100 points
  // 0% = 0, 12.5% = 50, 25%+ = 100
  const remScore = Math.min(100, (remPercent / 25) * 100);

  // Weighted combination
  const score = 0.5 * efficiencyScore + 0.3 * deepScore + 0.2 * remScore;

  // Interpretation
  let interpretation: "poor" | "fair" | "good" | "excellent";
  if (score < 50) interpretation = "poor";
  else if (score < 70) interpretation = "fair";
  else if (score < 85) interpretation = "good";
  else interpretation = "excellent";

  return {
    score: Math.round(score),
    components: {
      efficiencyScore: Math.round(efficiencyScore),
      deepScore: Math.round(deepScore),
      remScore: Math.round(remScore),
    },
    interpretation,
  };
}
