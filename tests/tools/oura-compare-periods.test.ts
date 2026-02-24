import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraTrendMetricForRange: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { handleOuraComparePeriods } from "../../src/tools/oura-compare-periods.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.getOuraTrendMetricForRange.mockReset();
});

describe("handleOuraComparePeriods", () => {
  it("compares two periods and returns deltas", async () => {
    mockQueries.getOuraTrendMetricForRange.mockResolvedValue([
      { day: new Date("2025-01-01"), value: 80 },
      { day: new Date("2025-01-02"), value: 82 },
      { day: new Date("2025-01-08"), value: 90 },
      { day: new Date("2025-01-09"), value: 92 },
    ]);
    const result = await handleOuraComparePeriods(mockPool, {
      from_a: "2025-01-01",
      to_a: "2025-01-07",
      from_b: "2025-01-08",
      to_b: "2025-01-14",
    });
    const parsed = JSON.parse(result);
    expect(parsed.sleep_score).toBeDefined();
    expect(parsed.sleep_score.period_a).toBe(81);
    expect(parsed.sleep_score.period_b).toBe(91);
    expect(parsed.sleep_score.change_percent).toBeCloseTo(12.35, 1);
    expect(parsed.hrv).toBeDefined();
    expect(parsed.steps).toBeDefined();
  });

  it("uses min/max dates for the query range", async () => {
    mockQueries.getOuraTrendMetricForRange.mockResolvedValue([]);
    await handleOuraComparePeriods(mockPool, {
      from_a: "2025-01-10",
      to_a: "2025-01-15",
      from_b: "2025-01-01",
      to_b: "2025-01-05",
    });
    // Should use from_b as startDate and to_a as endDate
    expect(mockQueries.getOuraTrendMetricForRange).toHaveBeenCalledWith(
      mockPool,
      expect.any(String),
      "2025-01-01",
      "2025-01-15"
    );
  });

  it("handles zero averages without division by zero", async () => {
    mockQueries.getOuraTrendMetricForRange.mockResolvedValue([]);
    const result = await handleOuraComparePeriods(mockPool, {
      from_a: "2025-01-01",
      to_a: "2025-01-07",
      from_b: "2025-01-08",
      to_b: "2025-01-14",
    });
    const parsed = JSON.parse(result);
    expect(parsed.sleep_score.change_percent).toBe(0);
  });

  it("rejects missing required dates", async () => {
    await expect(
      handleOuraComparePeriods(mockPool, { from_a: "2025-01-01" })
    ).rejects.toThrow();
  });
});
