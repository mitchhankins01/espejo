import { describe, it, expect } from "vitest";
import type { OuraSummaryRow } from "../../src/db/queries.js";
import {
  fmtDuration,
  formatOuraSummary,
  formatOuraWeekly,
} from "../../src/oura/formatters.js";

function makeRow(overrides: Partial<OuraSummaryRow> = {}): OuraSummaryRow {
  return {
    day: new Date("2025-01-15"),
    sleep_score: 85,
    readiness_score: 80,
    activity_score: 75,
    steps: 8000,
    stress: "normal",
    average_hrv: 42,
    average_heart_rate: 60,
    sleep_duration_seconds: 28800,
    deep_sleep_duration_seconds: 7200,
    rem_sleep_duration_seconds: 5400,
    efficiency: 90,
    workout_count: 1,
    ...overrides,
  };
}

describe("fmtDuration", () => {
  it("formats seconds to Xh Ym", () => {
    expect(fmtDuration(28800)).toBe("8h 0m");
    expect(fmtDuration(3660)).toBe("1h 1m");
    expect(fmtDuration(5400)).toBe("1h 30m");
  });

  it("returns n/a for null", () => {
    expect(fmtDuration(null)).toBe("n/a");
  });

  it("returns n/a for zero", () => {
    expect(fmtDuration(0)).toBe("n/a");
  });

  it("returns n/a for negative values", () => {
    expect(fmtDuration(-100)).toBe("n/a");
  });
});

describe("formatOuraSummary", () => {
  it("includes all key metrics", () => {
    const result = formatOuraSummary(makeRow());
    expect(result).toContain("2025-01-15");
    expect(result).toContain("Sleep 85");
    expect(result).toContain("Readiness 80");
    expect(result).toContain("Activity 75");
    expect(result).toContain("HRV 42ms");
    expect(result).toMatch(/8[,.]?000/);
    expect(result).toContain("normal");
    expect(result).toContain("8h 0m");
    expect(result).toContain("Efficiency 90%");
    expect(result).toContain("Workouts: 1");
  });

  it("shows n/a for null values", () => {
    const result = formatOuraSummary(
      makeRow({
        sleep_score: null,
        readiness_score: null,
        activity_score: null,
        steps: null,
        stress: null,
        average_hrv: null,
        sleep_duration_seconds: null,
        deep_sleep_duration_seconds: null,
        rem_sleep_duration_seconds: null,
        efficiency: null,
      })
    );
    expect(result).toContain("Sleep n/a");
    expect(result).toContain("Readiness n/a");
    expect(result).toContain("Activity n/a");
    expect(result).toContain("Steps n/a");
    expect(result).toContain("Stress n/a");
    expect(result).toContain("HRV n/a");
    expect(result).toContain("Efficiency n/a");
  });

  it("handles string day (PG date safety)", () => {
    const result = formatOuraSummary(
      makeRow({ day: "2025-01-15" as unknown as Date })
    );
    expect(result).toContain("2025-01-15");
  });
});

describe("formatOuraWeekly", () => {
  it("returns empty message for no rows", () => {
    expect(formatOuraWeekly([])).toBe(
      "No Oura data found for the selected week."
    );
  });

  it("formats a week of data", () => {
    const rows = [makeRow(), makeRow({ day: new Date("2025-01-16"), sleep_score: 90 })];
    const result = formatOuraWeekly(rows);
    expect(result).toContain("Last 2 days:");
    expect(result).toContain("Average sleep/readiness/activity:");
    expect(result).toContain("Average HRV:");
    expect(result).toContain("Total steps:");
    expect(result).toContain("2025-01-15");
    expect(result).toContain("2025-01-16");
    expect(result).toContain("Stress normal");
    expect(result).toContain("Eff 90%");
  });

  it("handles all null scores", () => {
    const rows = [
      makeRow({
        sleep_score: null,
        readiness_score: null,
        activity_score: null,
        average_hrv: null,
      }),
    ];
    const result = formatOuraWeekly(rows);
    expect(result).toContain("n/a/n/a/n/a");
    expect(result).toContain("Average HRV: n/a");
  });

  it("handles null steps and null per-row scores", () => {
    const rows = [
      makeRow({
        steps: null,
        sleep_score: null,
        readiness_score: null,
        activity_score: null,
        stress: null,
        efficiency: null,
      }),
    ];
    const result = formatOuraWeekly(rows);
    // steps ?? 0 fallback
    expect(result).toContain("Total steps: 0");
    // score ?? "-" fallbacks in per-row lines
    expect(result).toContain("Sleep -");
    expect(result).toContain("Ready -");
    expect(result).toContain("Activity -");
    expect(result).toContain("Steps -");
    expect(result).toContain("Stress -");
    expect(result).toContain("Eff -%");
  });
});
