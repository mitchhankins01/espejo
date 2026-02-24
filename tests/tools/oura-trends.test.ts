import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraTrendMetric: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { handleGetOuraTrends } from "../../src/tools/get-oura-trends.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.getOuraTrendMetric.mockReset();
});

describe("handleGetOuraTrends", () => {
  it("returns trend data for a metric", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValue([
      { day: new Date("2025-01-14"), value: 40 },
      { day: new Date("2025-01-15"), value: 42 },
    ]);
    const result = await handleGetOuraTrends(mockPool, {
      metric: "hrv",
      days: 30,
    });
    const parsed = JSON.parse(result);
    expect(parsed.metric).toBe("hrv");
    expect(parsed.days).toBe(30);
    expect(parsed.trend).toBeDefined();
    expect(parsed.points).toHaveLength(2);
    expect(parsed.rolling_average).toBeDefined();
  });

  it("returns no-data message when empty", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValue([]);
    const result = await handleGetOuraTrends(mockPool, {
      metric: "sleep_score",
      days: 30,
    });
    expect(result).toContain("No Oura trend data");
  });

  it("uses default metric and days", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValue([
      { day: new Date("2025-01-15"), value: 85 },
    ]);
    await handleGetOuraTrends(mockPool, {});
    expect(mockQueries.getOuraTrendMetric).toHaveBeenCalledWith(
      mockPool,
      "sleep_score",
      30
    );
  });

  it("rejects invalid metric", async () => {
    await expect(
      handleGetOuraTrends(mockPool, { metric: "invalid" })
    ).rejects.toThrow();
  });
});
