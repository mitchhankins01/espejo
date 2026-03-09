import { createHash } from "crypto";
import type { TemporalEchoRow, StaleTodoRow, OuraSummaryRow } from "../db/queries.js";
import { detectOutliers, trend, rollingAverages, mean, standardDeviation } from "../oura/analysis.js";

// ============================================================================
// Types
// ============================================================================

export type InsightType = "temporal_echo" | "biometric_correlation" | "stale_todo" | "oura_notable";

export interface InsightCandidate {
  type: InsightType;
  contentHash: string;
  title: string;
  body: string;
  relevance: number;
  metadata: Record<string, unknown>;
}

export interface BiometricOutlier {
  metric: string;
  value: number;
  direction: "high" | "low";
  zScore: number;
}

export interface NearbyEntry {
  uuid: string;
  preview: string;
  created_at: Date;
}

// ============================================================================
// Helpers
// ============================================================================

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ============================================================================
// Temporal Echoes
// ============================================================================

export function analyzeTemporalEchoes(echoes: TemporalEchoRow[]): InsightCandidate[] {
  // Dedupe: keep only the best match per echo entry
  const bestByEcho = new Map<string, TemporalEchoRow>();
  for (const echo of echoes) {
    const existing = bestByEcho.get(echo.echo_uuid);
    if (!existing || echo.similarity > existing.similarity) {
      bestByEcho.set(echo.echo_uuid, echo);
    }
  }

  return Array.from(bestByEcho.values()).map((echo) => ({
    type: "temporal_echo" as const,
    contentHash: hash(`temporal_echo:${echo.current_uuid}:${echo.echo_uuid}`),
    title: `Temporal echo from ${echo.echo_year}`,
    body: echo.echo_preview,
    relevance: echo.similarity,
    metadata: {
      current_uuid: echo.current_uuid,
      echo_uuid: echo.echo_uuid,
      echo_year: echo.echo_year,
      similarity: echo.similarity,
      current_preview: echo.current_preview,
    },
  }));
}

// ============================================================================
// Biometric-Journal Correlations
// ============================================================================

export function detectBiometricOutliers(summary: OuraSummaryRow): BiometricOutlier[] {
  const outliers: BiometricOutlier[] = [];

  // Use absolute thresholds for single-day detection (no historical window needed)
  if (summary.sleep_score != null && summary.sleep_score < 65) {
    outliers.push({ metric: "sleep_score", value: summary.sleep_score, direction: "low", zScore: (70 - summary.sleep_score) / 10 });
  }
  if (summary.readiness_score != null && summary.readiness_score < 65) {
    outliers.push({ metric: "readiness_score", value: summary.readiness_score, direction: "low", zScore: (70 - summary.readiness_score) / 10 });
  }
  if (summary.sleep_duration_seconds != null && summary.sleep_duration_seconds < 21600) {
    outliers.push({ metric: "sleep_duration", value: summary.sleep_duration_seconds, direction: "low", zScore: (25200 - summary.sleep_duration_seconds) / 3600 });
  }
  if (summary.average_hrv != null && summary.average_hrv < 20) {
    outliers.push({ metric: "hrv", value: summary.average_hrv, direction: "low", zScore: (30 - summary.average_hrv) / 10 });
  }

  return outliers;
}

export function analyzeBiometricCorrelations(
  day: string,
  outliers: BiometricOutlier[],
  entries: NearbyEntry[]
): InsightCandidate[] {
  if (outliers.length === 0 || entries.length === 0) return [];

  // Pick the most significant outlier
  const worst = outliers.reduce((a, b) => (Math.abs(a.zScore) > Math.abs(b.zScore) ? a : b));

  const entryPreviews = entries
    .slice(0, 2)
    .map((e) => e.preview)
    .join("\n\n");

  const metricLabel: Record<string, string> = {
    sleep_score: "Sleep score",
    readiness_score: "Readiness",
    sleep_duration: "Sleep duration",
    hrv: "HRV",
  };

  const label = metricLabel[worst.metric] ?? worst.metric;
  const valueStr = worst.metric === "sleep_duration"
    ? `${Math.round(worst.value / 60)}m`
    : `${Math.round(worst.value)}`;

  return [{
    type: "biometric_correlation" as const,
    contentHash: hash(`biometric:${day}:${worst.metric}:${worst.direction}`),
    title: `${label} is ${worst.direction} (${valueStr})`,
    body: entryPreviews,
    relevance: Math.min(Math.abs(worst.zScore) / 3, 1),
    metadata: {
      day,
      outliers,
      entry_uuids: entries.map((e) => e.uuid),
    },
  }];
}

// ============================================================================
// Stale Todo Detection
// ============================================================================

export function analyzeStaleTodos(todos: StaleTodoRow[]): InsightCandidate[] {
  return todos.map((todo) => ({
    type: "stale_todo" as const,
    // Week-bracket hash: resurfaces weekly
    contentHash: hash(`stale_todo:${todo.id}:${Math.floor(todo.days_stale / 7)}`),
    title: `Stale todo: ${todo.title}`,
    body: todo.next_step
      ? `Next step: ${todo.next_step}\nStale for ${todo.days_stale} days.`
      : `No next step defined. Stale for ${todo.days_stale} days.`,
    relevance: Math.min(
      (todo.days_stale / 30) * (todo.important ? 1.5 : 1),
      1
    ),
    metadata: {
      todo_id: todo.id,
      days_stale: todo.days_stale,
      important: todo.important,
      urgent: todo.urgent,
    },
  }));
}

// ============================================================================
// Oura Notable Changes
// ============================================================================

export interface OuraMetricSeries {
  metric: string;
  label: string;
  values: number[];
  unit?: string;
  higherIsBetter?: boolean;
}

export interface OuraStressDay {
  day_summary: string | null;
}

export interface OuraSleepContributors {
  day: string;
  contributors: Record<string, number> | null;
}

function getWeekNumber(date: Date = new Date()): number {
  const start = new Date(date.getFullYear(), 0, 1);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
}

function ouraHash(pattern: string, metric: string): string {
  const week = getWeekNumber();
  return hash(`oura_notable:${pattern}:${metric}:${week}`);
}

function checkRecentOutlier(series: OuraMetricSeries): InsightCandidate | null {
  if (series.values.length < 7) return null;
  const lastValue = series.values[series.values.length - 1];
  const result = detectOutliers(series.values);
  const isOutlier = result.outliers.some((o) => o.index === series.values.length - 1);
  if (!isOutlier) return null;

  const avg = mean(series.values);
  const std = standardDeviation(series.values);
  const higherIsBetter = series.higherIsBetter !== false;
  const isPositive = higherIsBetter ? lastValue > avg : lastValue < avg;
  const unitStr = series.unit ? ` ${series.unit}` : "";

  return {
    type: "oura_notable",
    contentHash: ouraHash("outlier", series.metric),
    title: isPositive
      ? `${series.label} spike: ${Math.round(lastValue)}${unitStr}`
      : `${series.label} drop: ${Math.round(lastValue)}${unitStr}`,
    body: `Baseline: ${Math.round(avg)} ± ${Math.round(std)}${unitStr}`,
    relevance: isPositive ? 0.8 : 0.9,
    metadata: {
      pattern: "outlier",
      metric: series.metric,
      value: lastValue,
      mean: avg,
      std,
      positive: isPositive,
    },
  };
}

function checkConsecutiveChange(series: OuraMetricSeries): InsightCandidate | null {
  if (series.values.length < 4) return null;
  const recent = series.values.slice(-7);
  if (recent.length < 3) return null;

  // Check declining streak from end
  let declineLen = 1;
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i] < recent[i - 1]) declineLen++;
    else break;
  }

  // Check improving streak from end
  let improveLen = 1;
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i] > recent[i - 1]) improveLen++;
    else break;
  }

  const higherIsBetter = series.higherIsBetter !== false;
  const unitStr = series.unit ? ` ${series.unit}` : "";

  if (declineLen >= 3) {
    const streakValues = recent.slice(-declineLen);
    const isPositive = !higherIsBetter; // declining is positive if lower is better
    return {
      type: "oura_notable",
      contentHash: ouraHash("consecutive_decline", series.metric),
      title: isPositive
        ? `${series.label} improving ${declineLen} days straight`
        : `${series.label} declining ${declineLen} days straight`,
      body: `${Math.round(streakValues[0])} → ${Math.round(streakValues[streakValues.length - 1])}${unitStr}`,
      relevance: isPositive ? 0.6 : 0.7 + Math.min(declineLen - 3, 2) * 0.05,
      metadata: {
        pattern: isPositive ? "consecutive_improvement" : "consecutive_decline",
        metric: series.metric,
        streak: declineLen,
        values: streakValues,
        positive: isPositive,
      },
    };
  }

  if (improveLen >= 3) {
    const streakValues = recent.slice(-improveLen);
    const isPositive = higherIsBetter;
    return {
      type: "oura_notable",
      contentHash: ouraHash("consecutive_improvement", series.metric),
      title: isPositive
        ? `${series.label} improving ${improveLen} days straight`
        : `${series.label} declining ${improveLen} days straight`,
      body: `${Math.round(streakValues[0])} → ${Math.round(streakValues[streakValues.length - 1])}${unitStr}`,
      relevance: isPositive ? 0.6 + Math.min(improveLen - 3, 2) * 0.05 : 0.7,
      metadata: {
        pattern: isPositive ? "consecutive_improvement" : "consecutive_decline",
        metric: series.metric,
        streak: improveLen,
        values: streakValues,
        positive: isPositive,
      },
    };
  }

  return null;
}

function checkRecoveryBounceback(series: OuraMetricSeries): InsightCandidate | null {
  if (series.values.length < 2) return null;
  const last = series.values[series.values.length - 1];
  const prev = series.values[series.values.length - 2];
  const jump = last - prev;

  if (Math.abs(jump) < 20) return null;

  const higherIsBetter = series.higherIsBetter !== false;
  const isPositive = higherIsBetter ? jump > 0 : jump < 0;
  if (!isPositive) return null;

  const unitStr = series.unit ? ` ${series.unit}` : "";

  return {
    type: "oura_notable",
    contentHash: ouraHash("bounceback", series.metric),
    title: `${series.label} bounced back ${Math.abs(Math.round(jump))} points to ${Math.round(last)}${unitStr}`,
    body: `Previous day: ${Math.round(prev)}${unitStr}`,
    relevance: 0.7 + Math.min(Math.abs(jump) / 100, 0.1),
    metadata: {
      pattern: "bounceback",
      metric: series.metric,
      value: last,
      previous: prev,
      jump,
      positive: true,
    },
  };
}

function checkSignificantTrend(series: OuraMetricSeries): InsightCandidate | null {
  if (series.values.length < 7) return null;
  const recent7 = series.values.slice(-7);
  const trendResult = trend(recent7);
  if (!trendResult.significant) return null;

  // Check if slope is meaningful relative to value range
  const avgs = rollingAverages(series.values);
  const diff7vs30 = avgs.day7.value - avgs.day30.value;
  if (Math.abs(diff7vs30) < standardDeviation(series.values) * 0.3) return null;

  const higherIsBetter = series.higherIsBetter !== false;
  const improving = higherIsBetter
    ? trendResult.direction === "improving"
    : trendResult.direction === "declining";
  const unitStr = series.unit ? ` ${series.unit}` : "";

  return {
    type: "oura_notable",
    contentHash: ouraHash("trend", series.metric),
    title: improving
      ? `${series.label} trending up over 7 days`
      : `${series.label} trending down over 7 days`,
    body: `7-day avg: ${Math.round(avgs.day7.value)}${unitStr}, 30-day avg: ${Math.round(avgs.day30.value)}${unitStr}`,
    relevance: improving ? 0.5 : 0.6 + Math.min(Math.abs(trendResult.rValue), 0.1),
    metadata: {
      pattern: "trend",
      metric: series.metric,
      direction: improving ? "improving" : "declining",
      slope: trendResult.slope,
      rValue: trendResult.rValue,
      avg7: avgs.day7.value,
      avg30: avgs.day30.value,
      positive: improving,
    },
  };
}

export function checkSustainedStress(stressDays: OuraStressDay[]): InsightCandidate | null {
  if (stressDays.length < 3) return null;

  // Check for restored streak (rare, positive)
  let restoredStreak = 0;
  for (let i = stressDays.length - 1; i >= 0; i--) {
    if (stressDays[i].day_summary === "restored") restoredStreak++;
    else break;
  }
  if (restoredStreak >= 3) {
    return {
      type: "oura_notable",
      contentHash: ouraHash("stress_restored", "stress"),
      title: `Restored state ${restoredStreak} days running`,
      body: "This is rare — only happens a few times a year. Keep doing what you're doing.",
      relevance: 0.6,
      metadata: {
        pattern: "stress_restored",
        metric: "stress",
        streak: restoredStreak,
        positive: true,
      },
    };
  }

  // Check for stressful streak
  let stressfulStreak = 0;
  for (let i = stressDays.length - 1; i >= 0; i--) {
    if (stressDays[i].day_summary === "stressful") stressfulStreak++;
    else break;
  }
  if (stressfulStreak >= 5) {
    return {
      type: "oura_notable",
      contentHash: ouraHash("stress_elevated", "stress"),
      title: `Stress elevated ${stressfulStreak} consecutive days`,
      body: "Consider adding recovery: lighter schedule, earlier bedtime, or a rest day.",
      relevance: 0.5 + Math.min((stressfulStreak - 5) * 0.02, 0.1),
      metadata: {
        pattern: "stress_elevated",
        metric: "stress",
        streak: stressfulStreak,
        positive: false,
      },
    };
  }

  return null;
}

export function checkActivityMilestone(series: OuraMetricSeries): InsightCandidate | null {
  if (series.metric !== "steps" || series.values.length < 3) return null;

  // Check for consecutive days above 15k steps
  let streak = 0;
  for (let i = series.values.length - 1; i >= 0; i--) {
    if (series.values[i] >= 15000) streak++;
    else break;
  }

  if (streak >= 3) {
    return {
      type: "oura_notable",
      contentHash: ouraHash("activity_milestone", "steps"),
      title: `High activity streak: ${streak} days above 15k steps`,
      body: `Avg: ${Math.round(mean(series.values.slice(-streak)))} steps/day`,
      relevance: 0.5 + Math.min((streak - 3) * 0.02, 0.1),
      metadata: {
        pattern: "activity_milestone",
        metric: "steps",
        streak,
        positive: true,
      },
    };
  }

  return null;
}

const CONTRIBUTOR_LABELS: Record<string, string> = {
  timing: "Sleep timing",
  rem_sleep: "REM sleep",
  deep_sleep: "Deep sleep",
  restfulness: "Restfulness",
  total_sleep: "Total sleep",
  latency: "Sleep latency",
  efficiency: "Sleep efficiency",
};

export function checkSleepContributors(days: OuraSleepContributors[]): InsightCandidate | null {
  if (days.length === 0) return null;
  const latest = days[days.length - 1];
  if (!latest.contributors) return null;

  let worstKey: string | null = null;
  let worstVal = Infinity;

  for (const [key, val] of Object.entries(latest.contributors)) {
    if (typeof val === "number" && val < worstVal) {
      worstVal = val;
      worstKey = key;
    }
  }

  if (worstKey == null || worstVal >= 25) return null;

  const label = CONTRIBUTOR_LABELS[worstKey] ?? worstKey;

  return {
    type: "oura_notable",
    contentHash: ouraHash("sleep_contributor", worstKey),
    title: `${label} score critically low: ${Math.round(worstVal)}/100`,
    body: "This contributor is dragging down your overall sleep score.",
    relevance: 0.5 + Math.min((25 - worstVal) / 50, 0.2),
    metadata: {
      pattern: "sleep_contributor",
      metric: worstKey,
      value: worstVal,
      day: latest.day,
      positive: false,
    },
  };
}

export function analyzeOuraNotable(
  metrics: OuraMetricSeries[],
  stressDays: OuraStressDay[] = [],
  sleepContributors: OuraSleepContributors[] = []
): InsightCandidate[] {
  const candidates: InsightCandidate[] = [];

  for (const series of metrics) {
    if (series.values.length === 0) continue;

    // Check each pattern type
    const outlier = checkRecentOutlier(series);
    if (outlier) candidates.push(outlier);

    const consecutive = checkConsecutiveChange(series);
    if (consecutive) candidates.push(consecutive);

    const bounceback = checkRecoveryBounceback(series);
    if (bounceback) candidates.push(bounceback);

    const trendCandidate = checkSignificantTrend(series);
    if (trendCandidate) candidates.push(trendCandidate);

    const activity = checkActivityMilestone(series);
    if (activity) candidates.push(activity);
  }

  const stressCandidate = checkSustainedStress(stressDays);
  if (stressCandidate) candidates.push(stressCandidate);

  const contributorCandidate = checkSleepContributors(sleepContributors);
  if (contributorCandidate) candidates.push(contributorCandidate);

  // Sort by relevance descending, return max 2
  candidates.sort((a, b) => b.relevance - a.relevance);
  return candidates.slice(0, 2);
}
