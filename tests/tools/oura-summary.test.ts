import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraSummaryByDay: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { handleGetOuraSummary } from "../../src/tools/get-oura-summary.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.getOuraSummaryByDay.mockReset();
});

describe("handleGetOuraSummary", () => {
  it("returns formatted summary for a given date", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue({
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
    });
    const result = await handleGetOuraSummary(mockPool, { date: "2025-01-15" });
    expect(result).toContain("2025-01-15");
    expect(result).toContain("Sleep 85");
    expect(mockQueries.getOuraSummaryByDay).toHaveBeenCalledWith(mockPool, "2025-01-15");
  });

  it("defaults to today when no date given", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue({
      day: new Date(),
      sleep_score: 80,
      readiness_score: 75,
      activity_score: 70,
      steps: 5000,
      stress: null,
      average_hrv: 40,
      average_heart_rate: 65,
      sleep_duration_seconds: 25200,
      deep_sleep_duration_seconds: 6000,
      rem_sleep_duration_seconds: 4500,
      efficiency: 85,
      workout_count: 0,
    });
    const result = await handleGetOuraSummary(mockPool, {});
    expect(result).toContain("Sleep 80");
    expect(mockQueries.getOuraSummaryByDay).toHaveBeenCalledWith(
      mockPool,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
  });

  it("returns not-found message when no data", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue(null);
    const result = await handleGetOuraSummary(mockPool, { date: "2020-01-01" });
    expect(result).toContain("No Oura data found");
    expect(result).toContain("2020-01-01");
  });

  it("rejects invalid date format", async () => {
    await expect(
      handleGetOuraSummary(mockPool, { date: "not-a-date" })
    ).rejects.toThrow();
  });
});
