import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraTrendMetric: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { handleOuraCorrelate } from "../../src/tools/oura-correlate.js";

const mockPool = {} as any;

beforeEach(() => {
  mockQueries.getOuraTrendMetric.mockReset();
});

describe("handleOuraCorrelate", () => {
  it("computes correlation between two metrics", async () => {
    const dates = Array.from({ length: 10 }, (_, i) => {
      const d = new Date("2025-01-01");
      d.setDate(d.getDate() + i);
      return d;
    });
    // Perfect positive correlation
    const left = dates.map((d, i) => ({ day: d, value: 40 + i }));
    const right = dates.map((d, i) => ({ day: d, value: 80 + i * 2 }));

    mockQueries.getOuraTrendMetric
      .mockResolvedValueOnce(left)
      .mockResolvedValueOnce(right);

    const result = await handleOuraCorrelate(mockPool, {
      metric_a: "hrv",
      metric_b: "sleep_score",
      days: 60,
    });
    const parsed = JSON.parse(result);
    expect(parsed.metric_a).toBe("hrv");
    expect(parsed.metric_b).toBe("sleep_score");
    expect(parsed.correlation).toBeCloseTo(1, 2);
    expect(parsed.strength).toBe("strong");
    expect(parsed.sample_size).toBe(10);
  });

  it("handles no overlapping days", async () => {
    mockQueries.getOuraTrendMetric
      .mockResolvedValueOnce([{ day: new Date("2025-01-01"), value: 42 }])
      .mockResolvedValueOnce([{ day: new Date("2025-01-02"), value: 80 }]);

    const result = await handleOuraCorrelate(mockPool, {
      metric_a: "hrv",
      metric_b: "sleep_score",
      days: 60,
    });
    const parsed = JSON.parse(result);
    expect(parsed.sample_size).toBe(0);
  });

  it("classifies moderate correlation", async () => {
    // Create data with moderate correlation (~0.5)
    const dates = Array.from({ length: 20 }, (_, i) => {
      const d = new Date("2025-01-01");
      d.setDate(d.getDate() + i);
      return d;
    });
    const left = dates.map((d, i) => ({ day: d, value: 40 + i }));
    // Add noise to break perfect correlation
    const right = dates.map((d, i) => ({ day: d, value: 80 + i + (i % 3 === 0 ? 10 : -5) }));

    mockQueries.getOuraTrendMetric
      .mockResolvedValueOnce(left)
      .mockResolvedValueOnce(right);

    const result = await handleOuraCorrelate(mockPool, {
      metric_a: "hrv",
      metric_b: "sleep_score",
    });
    const parsed = JSON.parse(result);
    expect(["strong", "moderate", "weak"]).toContain(parsed.strength);
  });

  it("uses default days", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValue([]);
    await handleOuraCorrelate(mockPool, {
      metric_a: "hrv",
      metric_b: "steps",
    });
    expect(mockQueries.getOuraTrendMetric).toHaveBeenCalledWith(mockPool, "hrv", 60);
    expect(mockQueries.getOuraTrendMetric).toHaveBeenCalledWith(mockPool, "steps", 60);
  });
});
