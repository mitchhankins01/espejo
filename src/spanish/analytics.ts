/**
 * Spanish learning analytics — pure formatting functions.
 *
 * This module is interface-agnostic: it accepts query results and returns
 * structured data or formatted text. Telegram, HTTP, and future UIs all
 * consume the same analytics layer.
 */

import type {
  RetentionBucketRow,
  VocabularyFunnelRow,
  GradeTrendRow,
  LapseRateTrendRow,
  SpanishProgressRow,
  SpanishQuizStatsRow,
  SpanishAdaptiveContextRow,
  SpanishAssessmentRow,
} from "../db/queries.js";

// ============================================================================
// Types
// ============================================================================

export interface SpanishDigest {
  period_label: string;
  stats: SpanishQuizStatsRow;
  adaptive: SpanishAdaptiveContextRow;
  retention_summary: RetentionSummary;
  funnel_summary: FunnelSummary;
  trend_summary: TrendSummary;
  assessment_summary: AssessmentSummary | null;
}

export interface RetentionSummary {
  overall_retention: number;
  best_bucket: string | null;
  worst_bucket: string | null;
  buckets: RetentionBucketRow[];
}

export interface FunnelSummary {
  total_words: number;
  by_state: VocabularyFunnelRow[];
}

export interface TrendSummary {
  grade_direction: "improving" | "declining" | "stable" | "insufficient";
  lapse_direction: "improving" | "declining" | "stable" | "insufficient";
  recent_avg_grade: number | null;
  recent_lapse_rate: number | null;
}

export interface AssessmentSummary {
  overall_score: number;
  complexity: number;
  grammar: number;
  vocabulary: number;
  code_switching_ratio: number;
  assessed_at: Date;
}

// ============================================================================
// Summary builders — pure functions
// ============================================================================

export function buildRetentionSummary(buckets: RetentionBucketRow[]): RetentionSummary {
  if (buckets.length === 0) {
    return { overall_retention: 0, best_bucket: null, worst_bucket: null, buckets };
  }

  const totalReviews = buckets.reduce((sum, b) => sum + b.total_reviews, 0);
  const totalRetained = buckets.reduce((sum, b) => sum + b.retained, 0);
  /* v8 ignore next */
  const overallRetention = totalReviews > 0 ? totalRetained / totalReviews : 0;

  const withData = buckets.filter((b) => b.total_reviews >= 3);
  const best = withData.length > 0
    ? withData.reduce((a, b) => (b.retention_rate > a.retention_rate ? b : a))
    : null;
  const worst = withData.length > 0
    ? withData.reduce((a, b) => (b.retention_rate < a.retention_rate ? b : a))
    : null;

  return {
    overall_retention: overallRetention,
    best_bucket: best?.interval_bucket ?? null,
    worst_bucket: worst?.interval_bucket ?? null,
    buckets,
  };
}

export function buildFunnelSummary(funnel: VocabularyFunnelRow[]): FunnelSummary {
  return {
    total_words: funnel.reduce((sum, f) => sum + f.count, 0),
    by_state: funnel,
  };
}

export function buildTrendSummary(
  grades: GradeTrendRow[],
  lapses: LapseRateTrendRow[]
): TrendSummary {
  const MIN_POINTS = 3;

  const gradeDirection = computeDirection(
    grades.map((g) => g.avg_grade),
    MIN_POINTS
  );
  const lapseDirection = computeLapseDirection(
    lapses.map((l) => l.lapse_rate),
    MIN_POINTS
  );

  const recentGrade = grades.length > 0 ? grades[grades.length - 1].avg_grade : null;
  const recentLapse = lapses.length > 0 ? lapses[lapses.length - 1].lapse_rate : null;

  return {
    grade_direction: gradeDirection,
    lapse_direction: lapseDirection,
    recent_avg_grade: recentGrade,
    recent_lapse_rate: recentLapse,
  };
}

export function buildAssessmentSummary(
  assessment: SpanishAssessmentRow | null
): AssessmentSummary | null {
  if (!assessment) return null;
  return {
    overall_score: assessment.overall_score,
    complexity: assessment.complexity_score,
    grammar: assessment.grammar_score,
    vocabulary: assessment.vocabulary_score,
    code_switching_ratio: assessment.code_switching_ratio,
    assessed_at: assessment.assessed_at,
  };
}

// ============================================================================
// Text formatting — for Telegram and other text interfaces
// ============================================================================

export function formatDigestText(digest: SpanishDigest): string {
  const lines: string[] = [];

  lines.push(`<b>Spanish Learning Digest</b> (${digest.period_label})`);
  lines.push("");

  // Stats overview
  const s = digest.stats;
  lines.push(`<b>Vocabulary:</b> ${s.total_words} words`);
  lines.push(
    `  new: ${s.new_words} · learning: ${s.learning_words} · review: ${s.review_words} · relearning: ${s.relearning_words}`
  );
  if (s.due_now > 0) lines.push(`  ${s.due_now} due now`);
  lines.push("");

  // Retention
  const r = digest.retention_summary;
  lines.push(
    `<b>Retention:</b> ${Math.round(r.overall_retention * 100)}% overall`
  );
  if (r.best_bucket) lines.push(`  best: ${r.best_bucket}`);
  if (r.worst_bucket && r.worst_bucket !== r.best_bucket) {
    lines.push(`  needs work: ${r.worst_bucket}`);
  }
  lines.push("");

  // Trends
  const t = digest.trend_summary;
  if (t.grade_direction !== "insufficient") {
    const gradeStr = t.recent_avg_grade != null ? t.recent_avg_grade.toFixed(1) : "?";
    const arrow = t.grade_direction === "improving" ? "↑" : t.grade_direction === "declining" ? "↓" : "→";
    lines.push(`<b>Grade trend:</b> ${gradeStr}/4 ${arrow}`);
  }
  if (t.lapse_direction !== "insufficient") {
    const lapseStr = t.recent_lapse_rate != null
      ? `${Math.round(t.recent_lapse_rate * 100)}%`
      : "?";
    const arrow = t.lapse_direction === "improving" ? "↓" : t.lapse_direction === "declining" ? "↑" : "→";
    lines.push(`<b>Lapse rate:</b> ${lapseStr} ${arrow}`);
  }
  lines.push("");

  // Adaptive status
  const a = digest.adaptive;
  if (a.total_reviews > 0) {
    const tier = a.recent_avg_grade < 2.3 || a.recent_lapse_rate > 0.3
      ? "struggling"
      : a.recent_avg_grade < 2.8
        ? "moderate"
        : a.recent_avg_grade >= 3.2 && a.recent_lapse_rate < 0.1
          ? "crushing it"
          : "healthy";
    lines.push(`<b>Status:</b> ${tier} (${a.total_reviews} reviews, ${a.mastered_count} mastered, ${a.struggling_count} struggling)`);
  } else {
    lines.push("<b>Status:</b> no reviews yet");
  }

  // Assessment
  if (digest.assessment_summary) {
    const as = digest.assessment_summary;
    lines.push("");
    lines.push(
      `<b>Conversation quality:</b> ${as.overall_score.toFixed(1)}/5`
    );
    lines.push(
      `  complexity: ${as.complexity.toFixed(1)} · grammar: ${as.grammar.toFixed(1)} · vocab: ${as.vocabulary.toFixed(1)}`
    );
    lines.push(
      `  code-switching: ${Math.round(as.code_switching_ratio * 100)}% Spanish`
    );
  }

  return lines.join("\n");
}

export function formatProgressTimeSeries(rows: SpanishProgressRow[]): string {
  if (rows.length === 0) return "No progress data yet.";
  const lines: string[] = ["<b>Progress timeline:</b>"];
  for (const row of rows.slice(-7)) {
    const dateStr = row.date instanceof Date
      ? row.date.toISOString().slice(0, 10)
      : String(row.date);
    lines.push(
      `  ${dateStr}: ${row.words_learned}w · ${row.reviews_today}r · streak ${row.streak_days}d`
    );
  }
  return lines.join("\n");
}

// ============================================================================
// Internal helpers
// ============================================================================

function computeDirection(
  values: number[],
  minPoints: number
): "improving" | "declining" | "stable" | "insufficient" {
  if (values.length < minPoints) return "insufficient";

  const half = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, half);
  const secondHalf = values.slice(half);

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const diff = avgSecond - avgFirst;
  if (diff > 0.2) return "improving";
  if (diff < -0.2) return "declining";
  return "stable";
}

function computeLapseDirection(
  values: number[],
  minPoints: number
): "improving" | "declining" | "stable" | "insufficient" {
  if (values.length < minPoints) return "insufficient";

  const half = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, half);
  const secondHalf = values.slice(half);

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  const diff = avgSecond - avgFirst;
  // For lapse rate, lower is better — so a decrease is "improving"
  if (diff < -0.05) return "improving";
  if (diff > 0.05) return "declining";
  return "stable";
}
