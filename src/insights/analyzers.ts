import { createHash } from "crypto";
import type { TemporalEchoRow, StaleTodoRow, OuraSummaryRow } from "../db/queries.js";

// ============================================================================
// Types
// ============================================================================

export type InsightType = "temporal_echo" | "biometric_correlation" | "stale_todo";

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
