import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraWeeklyRows: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { handleGetOuraWeekly } from "../../src/tools/get-oura-weekly.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.getOuraWeeklyRows.mockReset();
});

describe("handleGetOuraWeekly", () => {
  it("returns formatted weekly data", async () => {
    mockQueries.getOuraWeeklyRows.mockResolvedValue([
      {
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
      },
    ]);
    const result = await handleGetOuraWeekly(mockPool, { end_date: "2025-01-15" });
    expect(result).toContain("Last 1 days:");
    expect(mockQueries.getOuraWeeklyRows).toHaveBeenCalledWith(mockPool, "2025-01-15");
  });

  it("defaults end_date to today", async () => {
    mockQueries.getOuraWeeklyRows.mockResolvedValue([]);
    const result = await handleGetOuraWeekly(mockPool, {});
    expect(result).toContain("No Oura data found");
    expect(mockQueries.getOuraWeeklyRows).toHaveBeenCalledWith(
      mockPool,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
  });

  it("rejects invalid date format", async () => {
    await expect(
      handleGetOuraWeekly(mockPool, { end_date: "bad" })
    ).rejects.toThrow();
  });
});
