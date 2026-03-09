import { describe, it, expect } from "vitest";
import {
  analyzeOuraNotable,
  checkSustainedStress,
  checkActivityMilestone,
  checkSleepContributors,
  type OuraMetricSeries,
  type OuraStressDay,
  type OuraSleepContributors,
} from "../../src/insights/analyzers.js";

function makeSeries(overrides: Partial<OuraMetricSeries> = {}): OuraMetricSeries {
  return {
    metric: "sleep_score",
    label: "Sleep score",
    values: [],
    ...overrides,
  };
}

describe("analyzeOuraNotable", () => {
  it("returns empty array for empty input", () => {
    expect(analyzeOuraNotable([])).toEqual([]);
  });

  it("returns empty array for series with no values", () => {
    const series = [makeSeries({ values: [] })];
    expect(analyzeOuraNotable(series)).toEqual([]);
  });

  it("returns max 2 candidates", () => {
    // Create multiple series that each trigger an outlier
    const series: OuraMetricSeries[] = [
      makeSeries({
        metric: "sleep_score",
        label: "Sleep score",
        values: [78, 80, 76, 79, 82, 77, 80, 78, 81, 79, 80, 78, 76, 80, 42],
      }),
      makeSeries({
        metric: "readiness",
        label: "Readiness",
        values: [77, 75, 80, 78, 76, 79, 75, 77, 80, 78, 76, 75, 79, 77, 35],
      }),
      makeSeries({
        metric: "hrv",
        label: "HRV",
        unit: "ms",
        values: [67, 65, 70, 68, 72, 66, 69, 71, 68, 67, 70, 65, 68, 67, 15],
      }),
    ];

    const candidates = analyzeOuraNotable(series);
    expect(candidates.length).toBeLessThanOrEqual(2);
  });

  it("detects negative outlier (sleep score drop)", () => {
    const series = [
      makeSeries({
        metric: "sleep_score",
        label: "Sleep score",
        values: [78, 80, 76, 79, 82, 77, 80, 78, 81, 79, 80, 78, 76, 80, 42],
      }),
    ];

    const candidates = analyzeOuraNotable(series);
    const outlier = candidates.find((c) => c.metadata.pattern === "outlier");
    expect(outlier).toBeDefined();
    expect(outlier!.title).toContain("Sleep score drop");
    expect(outlier!.title).toContain("42");
    expect(outlier!.metadata.positive).toBe(false);
    expect(outlier!.relevance).toBeGreaterThanOrEqual(0.8);
  });

  it("detects positive outlier (HRV spike)", () => {
    const series = [
      makeSeries({
        metric: "hrv",
        label: "HRV",
        unit: "ms",
        values: [60, 65, 62, 68, 63, 67, 64, 66, 63, 65, 62, 67, 64, 63, 120],
      }),
    ];

    const candidates = analyzeOuraNotable(series);
    const outlier = candidates.find((c) => c.metadata.pattern === "outlier");
    expect(outlier).toBeDefined();
    expect(outlier!.title).toContain("HRV spike");
    expect(outlier!.title).toContain("120");
    expect(outlier!.metadata.positive).toBe(true);
    expect(outlier!.relevance).toBe(0.8);
  });

  it("detects consecutive decline", () => {
    const series = [
      makeSeries({
        metric: "sleep_score",
        label: "Sleep score",
        values: [78, 80, 82, 79, 85, 80, 78, 75, 70, 65, 92, 56, 42],
      }),
    ];

    const candidates = analyzeOuraNotable(series);
    const decline = candidates.find((c) => c.metadata.pattern === "consecutive_decline");
    expect(decline).toBeDefined();
    expect(decline!.title).toContain("declining");
    expect(decline!.title).toContain("days straight");
    expect(decline!.metadata.positive).toBe(false);
  });

  it("detects consecutive improvement", () => {
    const series = [
      makeSeries({
        metric: "readiness",
        label: "Readiness",
        values: [70, 68, 72, 67, 60, 65, 72, 81, 87],
      }),
    ];

    const candidates = analyzeOuraNotable(series);
    const improvement = candidates.find((c) => c.metadata.pattern === "consecutive_improvement");
    expect(improvement).toBeDefined();
    expect(improvement!.title).toContain("improving");
    expect(improvement!.metadata.positive).toBe(true);
  });

  it("detects recovery bounceback", () => {
    const series = [
      makeSeries({
        metric: "sleep_score",
        label: "Sleep score",
        // Need values that produce a bounceback but not an outlier (to avoid outlier consuming max 2)
        values: [78, 80, 82, 75, 80, 78, 55, 82],
      }),
    ];

    const candidates = analyzeOuraNotable(series);
    const bounceback = candidates.find((c) => c.metadata.pattern === "bounceback");
    expect(bounceback).toBeDefined();
    expect(bounceback!.title).toContain("bounced back");
    expect(bounceback!.title).toContain("27");
    expect(bounceback!.metadata.positive).toBe(true);
  });

  it("uses content hash with week bracket for dedup", () => {
    const series = [
      makeSeries({
        metric: "sleep_score",
        label: "Sleep score",
        values: [78, 80, 76, 79, 82, 77, 80, 78, 81, 79, 80, 78, 76, 80, 42],
      }),
    ];

    const candidates = analyzeOuraNotable(series);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.contentHash).toBeTruthy();
      expect(c.type).toBe("oura_notable");
    }
  });
});

describe("checkSustainedStress", () => {
  it("returns null for too few days", () => {
    expect(checkSustainedStress([{ day_summary: "stressful" }])).toBeNull();
  });

  it("detects restored streak of 3+", () => {
    const days: OuraStressDay[] = [
      { day_summary: "normal" },
      { day_summary: "restored" },
      { day_summary: "restored" },
      { day_summary: "restored" },
    ];
    const result = checkSustainedStress(days);
    expect(result).not.toBeNull();
    expect(result!.metadata.pattern).toBe("stress_restored");
    expect(result!.metadata.positive).toBe(true);
    expect(result!.metadata.streak).toBe(3);
  });

  it("detects stressful streak of 5+", () => {
    const days: OuraStressDay[] = [
      { day_summary: "normal" },
      { day_summary: "stressful" },
      { day_summary: "stressful" },
      { day_summary: "stressful" },
      { day_summary: "stressful" },
      { day_summary: "stressful" },
    ];
    const result = checkSustainedStress(days);
    expect(result).not.toBeNull();
    expect(result!.metadata.pattern).toBe("stress_elevated");
    expect(result!.metadata.positive).toBe(false);
  });

  it("returns null for mixed stress days", () => {
    const days: OuraStressDay[] = [
      { day_summary: "normal" },
      { day_summary: "stressful" },
      { day_summary: "normal" },
      { day_summary: "stressful" },
      { day_summary: "normal" },
    ];
    expect(checkSustainedStress(days)).toBeNull();
  });
});

describe("checkActivityMilestone", () => {
  it("returns null for non-steps metric", () => {
    const series = makeSeries({ metric: "hrv", values: [20000, 20000, 20000] });
    expect(checkActivityMilestone(series)).toBeNull();
  });

  it("returns null when streak < 3 days", () => {
    const series = makeSeries({ metric: "steps", values: [20000, 20000, 5000] });
    expect(checkActivityMilestone(series)).toBeNull();
  });

  it("detects 3+ day high activity streak", () => {
    const series = makeSeries({ metric: "steps", values: [5000, 16000, 18000, 20000] });
    const result = checkActivityMilestone(series);
    expect(result).not.toBeNull();
    expect(result!.metadata.pattern).toBe("activity_milestone");
    expect(result!.metadata.streak).toBe(3);
    expect(result!.metadata.positive).toBe(true);
  });
});

describe("checkSleepContributors", () => {
  it("returns null for empty days", () => {
    expect(checkSleepContributors([])).toBeNull();
  });

  it("returns null when no contributors", () => {
    const days: OuraSleepContributors[] = [{ day: "2026-03-09", contributors: null }];
    expect(checkSleepContributors(days)).toBeNull();
  });

  it("returns null when all contributors >= 25", () => {
    const days: OuraSleepContributors[] = [{
      day: "2026-03-09",
      contributors: { timing: 78, rem_sleep: 63, deep_sleep: 75, restfulness: 69, total_sleep: 77 },
    }];
    expect(checkSleepContributors(days)).toBeNull();
  });

  it("detects critically low contributor", () => {
    const days: OuraSleepContributors[] = [{
      day: "2026-03-09",
      contributors: { timing: 13, rem_sleep: 15, deep_sleep: 75, restfulness: 69, total_sleep: 25 },
    }];
    const result = checkSleepContributors(days);
    expect(result).not.toBeNull();
    expect(result!.title).toContain("Sleep timing");
    expect(result!.title).toContain("13");
    expect(result!.metadata.positive).toBe(false);
    expect(result!.relevance).toBeGreaterThan(0.5);
  });
});
