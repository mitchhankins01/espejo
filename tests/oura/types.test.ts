import { describe, it, expect } from "vitest";
import type {
  OuraApiListResponse,
  OuraSyncResult,
  OuraDailySummaryRow,
  OuraTrendPoint,
} from "../../src/oura/types.js";

describe("Oura types", () => {
  it("OuraApiListResponse shape is valid", () => {
    const response: OuraApiListResponse<{ id: string }> = {
      data: [{ id: "abc" }],
    };
    expect(response.data).toHaveLength(1);
  });

  it("OuraSyncResult shape is valid", () => {
    const result: OuraSyncResult = {
      endpoint: "daily_sleep",
      count: 5,
    };
    expect(result.endpoint).toBe("daily_sleep");
    expect(result.error).toBeUndefined();
  });

  it("OuraDailySummaryRow shape is valid", () => {
    const row: OuraDailySummaryRow = {
      day: "2025-01-15",
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
    };
    expect(row.day).toBe("2025-01-15");
  });

  it("OuraTrendPoint shape is valid", () => {
    const point: OuraTrendPoint = { day: "2025-01-15", value: 42 };
    expect(point.value).toBe(42);
  });
});
