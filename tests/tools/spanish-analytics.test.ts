import { describe, it, expect } from "vitest";
import {
  buildRetentionSummary,
  buildFunnelSummary,
  buildTrendSummary,
  buildAssessmentSummary,
  formatDigestText,
  formatProgressTimeSeries,
  type SpanishDigest,
} from "../../src/spanish/analytics.js";
import type {
  RetentionBucketRow,
  VocabularyFunnelRow,
  GradeTrendRow,
  LapseRateTrendRow,
  SpanishProgressRow,
  SpanishAssessmentRow,
} from "../../src/db/queries.js";

// ============================================================================
// buildRetentionSummary
// ============================================================================

describe("buildRetentionSummary", () => {
  it("returns zeroed summary for empty buckets", () => {
    const result = buildRetentionSummary([]);
    expect(result.overall_retention).toBe(0);
    expect(result.best_bucket).toBeNull();
    expect(result.worst_bucket).toBeNull();
    expect(result.buckets).toHaveLength(0);
  });

  it("computes overall retention from multiple buckets", () => {
    const buckets: RetentionBucketRow[] = [
      { interval_bucket: "0-1d", total_reviews: 10, retained: 9, retention_rate: 0.9 },
      { interval_bucket: "3-7d", total_reviews: 10, retained: 7, retention_rate: 0.7 },
    ];
    const result = buildRetentionSummary(buckets);
    expect(result.overall_retention).toBeCloseTo(0.8, 1);
    expect(result.buckets).toHaveLength(2);
  });

  it("identifies best and worst buckets with sufficient data", () => {
    const buckets: RetentionBucketRow[] = [
      { interval_bucket: "0-1d", total_reviews: 5, retained: 5, retention_rate: 1.0 },
      { interval_bucket: "7-14d", total_reviews: 5, retained: 2, retention_rate: 0.4 },
      { interval_bucket: "14-30d", total_reviews: 5, retained: 3, retention_rate: 0.6 },
    ];
    const result = buildRetentionSummary(buckets);
    expect(result.best_bucket).toBe("0-1d");
    expect(result.worst_bucket).toBe("7-14d");
  });

  it("handles unsorted buckets where best is not first", () => {
    const buckets: RetentionBucketRow[] = [
      { interval_bucket: "0-1d", total_reviews: 5, retained: 2, retention_rate: 0.4 },
      { interval_bucket: "3-7d", total_reviews: 5, retained: 5, retention_rate: 1.0 },
      { interval_bucket: "7-14d", total_reviews: 5, retained: 1, retention_rate: 0.2 },
    ];
    const result = buildRetentionSummary(buckets);
    expect(result.best_bucket).toBe("3-7d");
    expect(result.worst_bucket).toBe("7-14d");
  });

  it("returns null best/worst when all buckets have insufficient data", () => {
    const buckets: RetentionBucketRow[] = [
      { interval_bucket: "0-1d", total_reviews: 1, retained: 1, retention_rate: 1.0 },
      { interval_bucket: "3-7d", total_reviews: 2, retained: 1, retention_rate: 0.5 },
    ];
    const result = buildRetentionSummary(buckets);
    expect(result.best_bucket).toBeNull();
    expect(result.worst_bucket).toBeNull();
    expect(result.overall_retention).toBeGreaterThan(0);
  });

  it("ignores buckets with fewer than 3 reviews for best/worst", () => {
    const buckets: RetentionBucketRow[] = [
      { interval_bucket: "0-1d", total_reviews: 2, retained: 2, retention_rate: 1.0 },
      { interval_bucket: "3-7d", total_reviews: 5, retained: 3, retention_rate: 0.6 },
    ];
    const result = buildRetentionSummary(buckets);
    // Only "3-7d" has enough data, so it's both best and worst
    expect(result.best_bucket).toBe("3-7d");
    expect(result.worst_bucket).toBe("3-7d");
  });
});

// ============================================================================
// buildFunnelSummary
// ============================================================================

describe("buildFunnelSummary", () => {
  it("computes total words across states", () => {
    const funnel: VocabularyFunnelRow[] = [
      { state: "new", count: 10, median_days_in_state: 0.5 },
      { state: "learning", count: 5, median_days_in_state: 3.0 },
      { state: "review", count: 20, median_days_in_state: 14.0 },
    ];
    const result = buildFunnelSummary(funnel);
    expect(result.total_words).toBe(35);
    expect(result.by_state).toHaveLength(3);
  });

  it("handles empty funnel", () => {
    const result = buildFunnelSummary([]);
    expect(result.total_words).toBe(0);
    expect(result.by_state).toHaveLength(0);
  });
});

// ============================================================================
// buildTrendSummary
// ============================================================================

describe("buildTrendSummary", () => {
  it("returns insufficient when too few data points", () => {
    const grades: GradeTrendRow[] = [
      { date: "2026-02-20", avg_grade: 3.0, review_count: 5 },
    ];
    const lapses: LapseRateTrendRow[] = [
      { date: "2026-02-20", lapse_rate: 0.1, review_count: 5 },
    ];
    const result = buildTrendSummary(grades, lapses);
    expect(result.grade_direction).toBe("insufficient");
    expect(result.lapse_direction).toBe("insufficient");
  });

  it("detects improving grade trend", () => {
    const grades: GradeTrendRow[] = [
      { date: "2026-02-18", avg_grade: 2.0, review_count: 5 },
      { date: "2026-02-19", avg_grade: 2.2, review_count: 5 },
      { date: "2026-02-20", avg_grade: 2.5, review_count: 5 },
      { date: "2026-02-21", avg_grade: 3.0, review_count: 5 },
      { date: "2026-02-22", avg_grade: 3.2, review_count: 5 },
      { date: "2026-02-23", avg_grade: 3.5, review_count: 5 },
    ];
    const result = buildTrendSummary(grades, []);
    expect(result.grade_direction).toBe("improving");
    expect(result.recent_avg_grade).toBe(3.5);
  });

  it("detects declining grade trend", () => {
    const grades: GradeTrendRow[] = [
      { date: "2026-02-18", avg_grade: 3.5, review_count: 5 },
      { date: "2026-02-19", avg_grade: 3.2, review_count: 5 },
      { date: "2026-02-20", avg_grade: 3.0, review_count: 5 },
      { date: "2026-02-21", avg_grade: 2.5, review_count: 5 },
      { date: "2026-02-22", avg_grade: 2.2, review_count: 5 },
      { date: "2026-02-23", avg_grade: 2.0, review_count: 5 },
    ];
    const result = buildTrendSummary(grades, []);
    expect(result.grade_direction).toBe("declining");
  });

  it("detects stable grade trend", () => {
    const grades: GradeTrendRow[] = [
      { date: "2026-02-18", avg_grade: 3.0, review_count: 5 },
      { date: "2026-02-19", avg_grade: 3.1, review_count: 5 },
      { date: "2026-02-20", avg_grade: 2.9, review_count: 5 },
      { date: "2026-02-21", avg_grade: 3.0, review_count: 5 },
    ];
    const result = buildTrendSummary(grades, []);
    expect(result.grade_direction).toBe("stable");
  });

  it("detects improving lapse rate (decreasing)", () => {
    const lapses: LapseRateTrendRow[] = [
      { date: "2026-02-18", lapse_rate: 0.4, review_count: 5 },
      { date: "2026-02-19", lapse_rate: 0.35, review_count: 5 },
      { date: "2026-02-20", lapse_rate: 0.3, review_count: 5 },
      { date: "2026-02-21", lapse_rate: 0.2, review_count: 5 },
      { date: "2026-02-22", lapse_rate: 0.15, review_count: 5 },
      { date: "2026-02-23", lapse_rate: 0.1, review_count: 5 },
    ];
    const result = buildTrendSummary([], lapses);
    expect(result.lapse_direction).toBe("improving");
  });

  it("detects stable lapse rate", () => {
    const lapses: LapseRateTrendRow[] = [
      { date: "2026-02-18", lapse_rate: 0.2, review_count: 5 },
      { date: "2026-02-19", lapse_rate: 0.21, review_count: 5 },
      { date: "2026-02-20", lapse_rate: 0.19, review_count: 5 },
      { date: "2026-02-21", lapse_rate: 0.2, review_count: 5 },
    ];
    const result = buildTrendSummary([], lapses);
    expect(result.lapse_direction).toBe("stable");
  });

  it("detects declining lapse rate (increasing)", () => {
    const lapses: LapseRateTrendRow[] = [
      { date: "2026-02-18", lapse_rate: 0.1, review_count: 5 },
      { date: "2026-02-19", lapse_rate: 0.15, review_count: 5 },
      { date: "2026-02-20", lapse_rate: 0.2, review_count: 5 },
      { date: "2026-02-21", lapse_rate: 0.3, review_count: 5 },
      { date: "2026-02-22", lapse_rate: 0.35, review_count: 5 },
      { date: "2026-02-23", lapse_rate: 0.4, review_count: 5 },
    ];
    const result = buildTrendSummary([], lapses);
    expect(result.lapse_direction).toBe("declining");
  });

  it("returns recent values from last data point", () => {
    const grades: GradeTrendRow[] = [
      { date: "2026-02-22", avg_grade: 2.8, review_count: 3 },
      { date: "2026-02-23", avg_grade: 3.1, review_count: 4 },
    ];
    const lapses: LapseRateTrendRow[] = [
      { date: "2026-02-22", lapse_rate: 0.2, review_count: 3 },
      { date: "2026-02-23", lapse_rate: 0.15, review_count: 4 },
    ];
    const result = buildTrendSummary(grades, lapses);
    expect(result.recent_avg_grade).toBe(3.1);
    expect(result.recent_lapse_rate).toBe(0.15);
  });

  it("returns null for recent values with empty data", () => {
    const result = buildTrendSummary([], []);
    expect(result.recent_avg_grade).toBeNull();
    expect(result.recent_lapse_rate).toBeNull();
  });
});

// ============================================================================
// buildAssessmentSummary
// ============================================================================

describe("buildAssessmentSummary", () => {
  it("returns null for null assessment", () => {
    expect(buildAssessmentSummary(null)).toBeNull();
  });

  it("maps assessment row to summary", () => {
    const assessment: SpanishAssessmentRow = {
      id: 1,
      chat_id: "100",
      complexity_score: 3.5,
      grammar_score: 4.0,
      vocabulary_score: 3.2,
      code_switching_ratio: 0.75,
      overall_score: 3.6,
      sample_message_count: 15,
      rationale: "Good progress",
      assessed_at: new Date("2026-02-23"),
    };
    const result = buildAssessmentSummary(assessment);
    expect(result).not.toBeNull();
    expect(result!.overall_score).toBe(3.6);
    expect(result!.complexity).toBe(3.5);
    expect(result!.grammar).toBe(4.0);
    expect(result!.vocabulary).toBe(3.2);
    expect(result!.code_switching_ratio).toBe(0.75);
  });
});

// ============================================================================
// formatDigestText
// ============================================================================

describe("formatDigestText", () => {
  const baseDigest: SpanishDigest = {
    period_label: "last 30 days",
    stats: {
      total_words: 50,
      due_now: 5,
      new_words: 10,
      learning_words: 15,
      review_words: 20,
      relearning_words: 5,
      reviews_today: 8,
      average_grade: 3.2,
    },
    adaptive: {
      recent_avg_grade: 3.0,
      recent_lapse_rate: 0.15,
      avg_difficulty: 4.0,
      total_reviews: 100,
      mastered_count: 12,
      struggling_count: 3,
    },
    retention_summary: {
      overall_retention: 0.85,
      best_bucket: "0-1d",
      worst_bucket: "14-30d",
      buckets: [],
    },
    funnel_summary: {
      total_words: 50,
      by_state: [],
    },
    trend_summary: {
      grade_direction: "improving",
      lapse_direction: "stable",
      recent_avg_grade: 3.0,
      recent_lapse_rate: 0.15,
    },
    assessment_summary: null,
  };

  it("includes vocabulary stats", () => {
    const text = formatDigestText(baseDigest);
    expect(text).toContain("50 words");
    expect(text).toContain("new: 10");
    expect(text).toContain("5 due now");
  });

  it("includes retention info", () => {
    const text = formatDigestText(baseDigest);
    expect(text).toContain("85% overall");
    expect(text).toContain("best: 0-1d");
    expect(text).toContain("needs work: 14-30d");
  });

  it("includes grade trend with arrow", () => {
    const text = formatDigestText(baseDigest);
    expect(text).toContain("3.0/4 ↑");
  });

  it("includes status tier", () => {
    const text = formatDigestText(baseDigest);
    expect(text).toContain("healthy");
    expect(text).toContain("100 reviews");
  });

  it("includes assessment when present", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      assessment_summary: {
        overall_score: 3.8,
        complexity: 3.5,
        grammar: 4.0,
        vocabulary: 3.2,
        code_switching_ratio: 0.82,
        assessed_at: new Date("2026-02-23"),
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("3.8/5");
    expect(text).toContain("82% Spanish");
  });

  it("omits assessment when null", () => {
    const text = formatDigestText(baseDigest);
    expect(text).not.toContain("Conversation quality");
  });

  it("shows struggling tier when grade is low", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      adaptive: { ...baseDigest.adaptive, recent_avg_grade: 2.0, recent_lapse_rate: 0.35 },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("struggling");
  });

  it("shows crushing-it tier when grade is high and lapses low", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      adaptive: { ...baseDigest.adaptive, recent_avg_grade: 3.5, recent_lapse_rate: 0.05 },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("crushing it");
  });

  it("shows moderate tier when grade is moderate", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      adaptive: { ...baseDigest.adaptive, recent_avg_grade: 2.6, recent_lapse_rate: 0.15 },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("moderate");
  });

  it("shows no-reviews status when total_reviews is 0", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      adaptive: { ...baseDigest.adaptive, total_reviews: 0 },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("no reviews yet");
  });

  it("omits due-now line when zero", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      stats: { ...baseDigest.stats, due_now: 0 },
    };
    const text = formatDigestText(digest);
    expect(text).not.toContain("due now");
  });

  it("omits worst bucket when same as best", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      retention_summary: {
        ...baseDigest.retention_summary,
        best_bucket: "0-1d",
        worst_bucket: "0-1d",
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("best: 0-1d");
    expect(text).not.toContain("needs work");
  });

  it("shows ? when lapse rate is null but direction is not insufficient", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      trend_summary: {
        ...baseDigest.trend_summary,
        lapse_direction: "stable",
        recent_lapse_rate: null,
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("? →");
  });

  it("shows declining grade arrow as ↓", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      trend_summary: {
        ...baseDigest.trend_summary,
        grade_direction: "declining",
        recent_avg_grade: 2.0,
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("2.0/4 ↓");
  });

  it("shows stable grade arrow as →", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      trend_summary: {
        ...baseDigest.trend_summary,
        grade_direction: "stable",
        recent_avg_grade: 3.0,
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("3.0/4 →");
  });

  it("shows ? when grade is null but direction is not insufficient", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      trend_summary: {
        ...baseDigest.trend_summary,
        grade_direction: "stable",
        recent_avg_grade: null,
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("?/4 →");
  });

  it("shows improving lapse arrow as ↓", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      trend_summary: {
        ...baseDigest.trend_summary,
        lapse_direction: "improving",
        recent_lapse_rate: 0.1,
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("10% ↓");
  });

  it("shows declining lapse arrow as ↑", () => {
    const digest: SpanishDigest = {
      ...baseDigest,
      trend_summary: {
        ...baseDigest.trend_summary,
        lapse_direction: "declining",
        recent_lapse_rate: 0.3,
      },
    };
    const text = formatDigestText(digest);
    expect(text).toContain("30% ↑");
  });
});

// ============================================================================
// formatProgressTimeSeries
// ============================================================================

describe("formatProgressTimeSeries", () => {
  it("returns message for empty data", () => {
    expect(formatProgressTimeSeries([])).toBe("No progress data yet.");
  });

  it("formats up to 7 most recent rows", () => {
    const rows: SpanishProgressRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      chat_id: "100",
      date: new Date(`2026-02-${String(i + 14).padStart(2, "0")}`),
      words_learned: 10 + i,
      words_in_progress: 5 + i,
      reviews_today: 3 + i,
      new_words_today: 2,
      tenses_practiced: ["presente"],
      streak_days: i + 1,
      created_at: new Date(),
      updated_at: new Date(),
    }));
    const text = formatProgressTimeSeries(rows);
    // Should only show last 7
    expect(text).toContain("2026-02-23");
    expect(text).not.toContain("2026-02-14");
    expect(text).not.toContain("2026-02-15");
    expect(text).not.toContain("2026-02-16");
    expect(text).toContain("Progress timeline");
  });

  it("handles string dates (not Date objects)", () => {
    const rows: SpanishProgressRow[] = [{
      id: 1,
      chat_id: "100",
      date: "2026-02-23" as unknown as Date,
      words_learned: 15,
      words_in_progress: 8,
      reviews_today: 5,
      new_words_today: 2,
      tenses_practiced: ["presente"],
      streak_days: 3,
      created_at: new Date(),
      updated_at: new Date(),
    }];
    const text = formatProgressTimeSeries(rows);
    expect(text).toContain("2026-02-23");
    expect(text).toContain("15w");
  });

  it("formats single row correctly", () => {
    const rows: SpanishProgressRow[] = [{
      id: 1,
      chat_id: "100",
      date: new Date("2026-02-23"),
      words_learned: 15,
      words_in_progress: 8,
      reviews_today: 5,
      new_words_today: 2,
      tenses_practiced: ["presente"],
      streak_days: 3,
      created_at: new Date(),
      updated_at: new Date(),
    }];
    const text = formatProgressTimeSeries(rows);
    expect(text).toContain("15w");
    expect(text).toContain("5r");
    expect(text).toContain("streak 3d");
  });
});
