import { describe, it, expect } from "vitest";
import {
  analyzeTemporalEchoes,
  analyzeBiometricCorrelations,
  analyzeStaleTodos,
  detectBiometricOutliers,
} from "../../src/insights/analyzers.js";
import type { TemporalEchoRow, StaleTodoRow, OuraSummaryRow } from "../../src/db/queries.js";

describe("analyzeTemporalEchoes", () => {
  it("returns empty array for empty input", () => {
    expect(analyzeTemporalEchoes([])).toEqual([]);
  });

  it("creates candidates with correct type and hash", () => {
    const echoes: TemporalEchoRow[] = [
      {
        current_uuid: "uuid-today",
        echo_uuid: "uuid-2023",
        echo_year: 2023,
        similarity: 0.85,
        echo_preview: "Felt overwhelmed by work...",
        current_preview: "Work pressure is building again...",
      },
    ];

    const candidates = analyzeTemporalEchoes(echoes);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("temporal_echo");
    expect(candidates[0].relevance).toBe(0.85);
    expect(candidates[0].title).toBe("Temporal echo from 2023");
    expect(candidates[0].contentHash).toBeTruthy();
    expect(candidates[0].metadata.current_uuid).toBe("uuid-today");
    expect(candidates[0].metadata.echo_uuid).toBe("uuid-2023");
  });

  it("deduplicates by echo_uuid keeping highest similarity", () => {
    const echoes: TemporalEchoRow[] = [
      {
        current_uuid: "today-1",
        echo_uuid: "past-1",
        echo_year: 2022,
        similarity: 0.80,
        echo_preview: "preview",
        current_preview: "current",
      },
      {
        current_uuid: "today-2",
        echo_uuid: "past-1",
        echo_year: 2022,
        similarity: 0.90,
        echo_preview: "preview",
        current_preview: "current better",
      },
    ];

    const candidates = analyzeTemporalEchoes(echoes);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relevance).toBe(0.90);
  });

  it("generates different hashes for different echo pairs", () => {
    const echoes: TemporalEchoRow[] = [
      {
        current_uuid: "today-1",
        echo_uuid: "past-1",
        echo_year: 2022,
        similarity: 0.80,
        echo_preview: "a",
        current_preview: "b",
      },
      {
        current_uuid: "today-1",
        echo_uuid: "past-2",
        echo_year: 2021,
        similarity: 0.78,
        echo_preview: "c",
        current_preview: "d",
      },
    ];

    const candidates = analyzeTemporalEchoes(echoes);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].contentHash).not.toBe(candidates[1].contentHash);
  });
});

describe("detectBiometricOutliers", () => {
  it("returns empty for healthy values", () => {
    const summary: OuraSummaryRow = {
      day: new Date(),
      sleep_score: 85,
      readiness_score: 80,
      activity_score: 75,
      steps: 8000,
      stress: "normal",
      average_hrv: 45,
      average_heart_rate: 60,
      sleep_duration_seconds: 28800,
      deep_sleep_duration_seconds: 5400,
      rem_sleep_duration_seconds: 7200,
      efficiency: 0.9,
      workout_count: 1,
    };

    expect(detectBiometricOutliers(summary)).toEqual([]);
  });

  it("detects low sleep score", () => {
    const summary: OuraSummaryRow = {
      day: new Date(),
      sleep_score: 55,
      readiness_score: 80,
      activity_score: 75,
      steps: 8000,
      stress: null,
      average_hrv: 45,
      average_heart_rate: 60,
      sleep_duration_seconds: 28800,
      deep_sleep_duration_seconds: null,
      rem_sleep_duration_seconds: null,
      efficiency: null,
      workout_count: 0,
    };

    const outliers = detectBiometricOutliers(summary);
    expect(outliers).toHaveLength(1);
    expect(outliers[0].metric).toBe("sleep_score");
    expect(outliers[0].direction).toBe("low");
  });

  it("detects multiple outliers", () => {
    const summary: OuraSummaryRow = {
      day: new Date(),
      sleep_score: 50,
      readiness_score: 55,
      activity_score: null,
      steps: null,
      stress: null,
      average_hrv: 15,
      average_heart_rate: null,
      sleep_duration_seconds: 18000,
      deep_sleep_duration_seconds: null,
      rem_sleep_duration_seconds: null,
      efficiency: null,
      workout_count: 0,
    };

    const outliers = detectBiometricOutliers(summary);
    expect(outliers.length).toBeGreaterThanOrEqual(3);
  });

  it("handles null values gracefully", () => {
    const summary: OuraSummaryRow = {
      day: new Date(),
      sleep_score: null,
      readiness_score: null,
      activity_score: null,
      steps: null,
      stress: null,
      average_hrv: null,
      average_heart_rate: null,
      sleep_duration_seconds: null,
      deep_sleep_duration_seconds: null,
      rem_sleep_duration_seconds: null,
      efficiency: null,
      workout_count: 0,
    };

    expect(detectBiometricOutliers(summary)).toEqual([]);
  });
});

describe("analyzeBiometricCorrelations", () => {
  it("returns empty for no outliers", () => {
    expect(analyzeBiometricCorrelations("2026-03-08", [], [])).toEqual([]);
  });

  it("returns empty for outliers but no entries", () => {
    const outliers = [{ metric: "sleep_score", value: 50, direction: "low" as const, zScore: 2 }];
    expect(analyzeBiometricCorrelations("2026-03-08", outliers, [])).toEqual([]);
  });

  it("creates candidate from outlier + entries", () => {
    const outliers = [{ metric: "sleep_score", value: 50, direction: "low" as const, zScore: 2 }];
    const entries = [{ uuid: "e1", preview: "Couldn't sleep last night...", created_at: new Date() }];

    const candidates = analyzeBiometricCorrelations("2026-03-08", outliers, entries);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("biometric_correlation");
    expect(candidates[0].title).toContain("Sleep score");
    expect(candidates[0].title).toContain("low");
  });

  it("picks worst outlier by zScore", () => {
    const outliers = [
      { metric: "sleep_score", value: 60, direction: "low" as const, zScore: 1 },
      { metric: "hrv", value: 10, direction: "low" as const, zScore: 2.5 },
    ];
    const entries = [{ uuid: "e1", preview: "entry", created_at: new Date() }];

    const candidates = analyzeBiometricCorrelations("2026-03-08", outliers, entries);
    expect(candidates[0].title).toContain("HRV");
  });

  it("formats sleep_duration value as minutes", () => {
    const outliers = [{ metric: "sleep_duration", value: 18000, direction: "low" as const, zScore: 2 }];
    const entries = [{ uuid: "e1", preview: "entry", created_at: new Date() }];

    const candidates = analyzeBiometricCorrelations("2026-03-08", outliers, entries);
    expect(candidates[0].title).toContain("300m");
  });
});

describe("analyzeStaleTodos", () => {
  it("returns empty for empty input", () => {
    expect(analyzeStaleTodos([])).toEqual([]);
  });

  it("creates candidates with correct type", () => {
    const todos: StaleTodoRow[] = [
      { id: "todo-1", title: "Fix taxes", days_stale: 14, important: true, urgent: false, next_step: "Call accountant" },
    ];

    const candidates = analyzeStaleTodos(todos);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("stale_todo");
    expect(candidates[0].title).toContain("Fix taxes");
    expect(candidates[0].body).toContain("Call accountant");
    expect(candidates[0].body).toContain("14 days");
  });

  it("handles todo without next_step", () => {
    const todos: StaleTodoRow[] = [
      { id: "todo-2", title: "Learn Rust", days_stale: 21, important: false, urgent: false, next_step: null },
    ];

    const candidates = analyzeStaleTodos(todos);
    expect(candidates[0].body).toContain("No next step defined");
  });

  it("gives higher relevance to important todos", () => {
    const todos: StaleTodoRow[] = [
      { id: "todo-a", title: "Important one", days_stale: 10, important: true, urgent: false, next_step: null },
      { id: "todo-b", title: "Not important", days_stale: 10, important: false, urgent: false, next_step: null },
    ];

    const candidates = analyzeStaleTodos(todos);
    const importantCandidate = candidates.find((c) => c.title.includes("Important one"))!;
    const normalCandidate = candidates.find((c) => c.title.includes("Not important"))!;
    expect(importantCandidate.relevance).toBeGreaterThan(normalCandidate.relevance);
  });

  it("caps relevance at 1.0", () => {
    const todos: StaleTodoRow[] = [
      { id: "todo-x", title: "Very old", days_stale: 60, important: true, urgent: false, next_step: null },
    ];

    const candidates = analyzeStaleTodos(todos);
    expect(candidates[0].relevance).toBeLessThanOrEqual(1);
  });

  it("uses week-bracket for dedup hash", () => {
    const todosWeek1: StaleTodoRow[] = [
      { id: "todo-1", title: "Test", days_stale: 7, important: false, urgent: false, next_step: null },
    ];
    const todosWeek2: StaleTodoRow[] = [
      { id: "todo-1", title: "Test", days_stale: 14, important: false, urgent: false, next_step: null },
    ];

    const hash1 = analyzeStaleTodos(todosWeek1)[0].contentHash;
    const hash2 = analyzeStaleTodos(todosWeek2)[0].contentHash;
    expect(hash1).not.toBe(hash2);
  });
});
