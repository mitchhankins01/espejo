import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getOuraTrendMetric: vi.fn(),
  getOuraSleepDetailForRange: vi.fn(),
  getOuraTemperatureData: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => ({
  config: { timezone: "Europe/Madrid" },
}));

import { handleGetOuraAnalysis } from "../../src/tools/get-oura-analysis.js";

const mockPool = {} as any;

function makeSleepRows(count: number, opts: { withStages?: boolean; withBedtime?: boolean; withSteps?: boolean; withWorkouts?: boolean } = {}): any[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date("2025-01-01");
    d.setDate(d.getDate() + i);
    return {
      day: d,
      score: 75 + (i % 10),
      total_sleep_duration_seconds: 25200 + i * 100,
      deep_sleep_duration_seconds: opts.withStages !== false ? 6000 : null,
      rem_sleep_duration_seconds: opts.withStages !== false ? 5400 : null,
      light_sleep_duration_seconds: opts.withStages !== false ? 13800 : null,
      efficiency: 88,
      average_hrv: 42 + i,
      average_heart_rate: 60,
      bedtime_start: opts.withBedtime !== false ? new Date(`2025-01-${String(i + 1).padStart(2, "0")}T22:30:00Z`) : null,
      bedtime_end: opts.withBedtime !== false ? new Date(`2025-01-${String(i + 2).padStart(2, "0")}T06:30:00Z`) : null,
      steps: opts.withSteps !== false ? 8000 + i * 100 : null,
      activity_score: 70,
      workout_count: opts.withWorkouts !== false ? (i % 3 === 0 ? 1 : 0) : 0,
    };
  });
}

function makeTrendPoints(count: number, baseValue: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(`2025-01-${String(i + 1).padStart(2, "0")}`),
    value: baseValue + i,
  }));
}

beforeEach(() => {
  for (const fn of Object.values(mockQueries)) fn.mockReset();
});

describe("handleGetOuraAnalysis", () => {
  describe("sleep_quality", () => {
    it("returns sleep quality analysis", async () => {
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(makeSleepRows(10));
      const result = await handleGetOuraAnalysis(mockPool, { type: "sleep_quality" });
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("sleep_quality");
      expect(parsed.days).toBe(10);
      expect(parsed.trend).toBeDefined();
      expect(parsed.average_score).toBeGreaterThan(0);
      expect(parsed.sleep_debt).toBeDefined();
      expect(parsed.regularity).toBeDefined();
      expect(parsed.day_of_week).toBeDefined();
      expect(parsed.latest_stages).toBeDefined();
    });

    it("returns insufficient data message for < 3 days", async () => {
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(makeSleepRows(2));
      const result = await handleGetOuraAnalysis(mockPool, { type: "sleep_quality" });
      expect(result).toContain("Insufficient");
    });

    it("handles missing stage data", async () => {
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(
        makeSleepRows(5, { withStages: false })
      );
      const result = await handleGetOuraAnalysis(mockPool, { type: "sleep_quality" });
      const parsed = JSON.parse(result);
      expect(parsed.latest_stages).toBeNull();
    });

    it("handles missing bedtime data", async () => {
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(
        makeSleepRows(5, { withBedtime: false })
      );
      const result = await handleGetOuraAnalysis(mockPool, { type: "sleep_quality" });
      const parsed = JSON.parse(result);
      expect(parsed.regularity).toBeNull();
    });
  });

  describe("anomalies", () => {
    it("detects anomalies across metrics", async () => {
      // Generate 15 points with one outlier at the end
      const points = makeTrendPoints(15, 80);
      points.push({ day: new Date("2025-01-20"), value: 20 }); // extreme outlier
      mockQueries.getOuraTrendMetric.mockResolvedValue(points);

      const result = await handleGetOuraAnalysis(mockPool, { type: "anomalies" });
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("anomalies");
      expect(parsed.days).toBeGreaterThan(0);
    });

    it("skips metrics with fewer than 7 data points", async () => {
      mockQueries.getOuraTrendMetric.mockResolvedValue(makeTrendPoints(5, 80));
      const result = await handleGetOuraAnalysis(mockPool, { type: "anomalies" });
      const parsed = JSON.parse(result);
      expect(parsed.total).toBe(0);
    });
  });

  describe("hrv_trend", () => {
    it("returns HRV trend analysis", async () => {
      mockQueries.getOuraTrendMetric.mockResolvedValue(makeTrendPoints(15, 40));
      const result = await handleGetOuraAnalysis(mockPool, { type: "hrv_trend" });
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("hrv_trend");
      expect(parsed.current).toBeDefined();
      expect(parsed.average).toBeDefined();
      expect(parsed.trend).toBeDefined();
      expect(parsed.rolling_averages).toBeDefined();
      expect(parsed.rolling_averages["7d"]).toBeDefined();
      expect(parsed.day_of_week).toBeDefined();
    });

    it("returns insufficient data for < 3 points", async () => {
      mockQueries.getOuraTrendMetric.mockResolvedValue(makeTrendPoints(2, 40));
      const result = await handleGetOuraAnalysis(mockPool, { type: "hrv_trend" });
      expect(result).toContain("Insufficient");
    });
  });

  describe("temperature", () => {
    it("returns temperature analysis", async () => {
      const points = Array.from({ length: 10 }, (_, i) => ({
        day: new Date(`2025-01-${String(i + 1).padStart(2, "0")}`),
        temperature_deviation: 0.1 * (i - 5),
      }));
      mockQueries.getOuraTemperatureData.mockResolvedValue(points);
      const result = await handleGetOuraAnalysis(mockPool, { type: "temperature" });
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("temperature");
      expect(parsed.days).toBe(10);
      expect(parsed.average_deviation).toBeDefined();
      expect(parsed.trend).toBeDefined();
      expect(parsed.flagged_days).toBeDefined();
    });

    it("returns insufficient data for < 3 points", async () => {
      mockQueries.getOuraTemperatureData.mockResolvedValue([
        { day: new Date("2025-01-15"), temperature_deviation: 0.1 },
      ]);
      const result = await handleGetOuraAnalysis(mockPool, { type: "temperature" });
      expect(result).toContain("Insufficient");
    });

    it("flags temperature outliers", async () => {
      const points = Array.from({ length: 10 }, (_, i) => ({
        day: new Date(`2025-01-${String(i + 1).padStart(2, "0")}`),
        temperature_deviation: 0.1,
      }));
      // Add extreme outlier
      points.push({ day: new Date("2025-01-15"), temperature_deviation: 3.0 });
      mockQueries.getOuraTemperatureData.mockResolvedValue(points);
      const result = await handleGetOuraAnalysis(mockPool, { type: "temperature" });
      const parsed = JSON.parse(result);
      expect(parsed.flagged_days.length).toBeGreaterThan(0);
      expect(parsed.flagged_days[0].deviation).toBeDefined();
    });
  });

  describe("best_sleep", () => {
    it("returns best sleep conditions analysis", async () => {
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(makeSleepRows(10));
      const result = await handleGetOuraAnalysis(mockPool, { type: "best_sleep" });
      const parsed = JSON.parse(result);
      expect(parsed.type).toBe("best_sleep");
      expect(parsed.days).toBe(10);
      expect(parsed.day_of_week).toBeDefined();
      expect(parsed.activity_correlation).toBeDefined();
      expect(parsed.workout_impact).toBeDefined();
      expect(parsed.workout_impact.workout_days.count).toBeGreaterThan(0);
      expect(parsed.workout_impact.rest_days.count).toBeGreaterThan(0);
    });

    it("returns insufficient data for < 7 days", async () => {
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(makeSleepRows(5));
      const result = await handleGetOuraAnalysis(mockPool, { type: "best_sleep" });
      expect(result).toContain("Insufficient");
    });

    it("handles no workout days (all rest)", async () => {
      const rows = makeSleepRows(10, { withWorkouts: false });
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(rows);
      const result = await handleGetOuraAnalysis(mockPool, { type: "best_sleep" });
      const parsed = JSON.parse(result);
      expect(parsed.workout_impact.workout_days.count).toBe(0);
      expect(parsed.workout_impact.workout_days.avg_sleep).toBeNull();
    });

    it("handles all workout days (no rest)", async () => {
      const rows = makeSleepRows(10).map((r) => ({ ...r, workout_count: 1 }));
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(rows);
      const result = await handleGetOuraAnalysis(mockPool, { type: "best_sleep" });
      const parsed = JSON.parse(result);
      expect(parsed.workout_impact.rest_days.count).toBe(0);
      expect(parsed.workout_impact.rest_days.avg_sleep).toBeNull();
    });

    it("skips steps correlation when < 5 data points", async () => {
      const rows = makeSleepRows(7, { withSteps: false });
      // Give just a few rows steps values
      rows[0].steps = 8000;
      rows[0].score = 80;
      rows[1].steps = 9000;
      rows[1].score = 85;
      mockQueries.getOuraSleepDetailForRange.mockResolvedValue(rows);
      const result = await handleGetOuraAnalysis(mockPool, { type: "best_sleep" });
      const parsed = JSON.parse(result);
      expect(parsed.activity_correlation).toBeNull();
    });
  });

  it("rejects invalid analysis type", async () => {
    await expect(
      handleGetOuraAnalysis(mockPool, { type: "invalid" })
    ).rejects.toThrow();
  });

  it("uses default days", async () => {
    mockQueries.getOuraSleepDetailForRange.mockResolvedValue(makeSleepRows(10));
    await handleGetOuraAnalysis(mockPool, { type: "sleep_quality" });
    expect(mockQueries.getOuraSleepDetailForRange).toHaveBeenCalledWith(mockPool, 60);
  });

  it("handles string day values from PG", async () => {
    const rows = makeSleepRows(5).map((r) => ({ ...r, day: "2025-01-15" }));
    mockQueries.getOuraSleepDetailForRange.mockResolvedValue(rows);
    const result = await handleGetOuraAnalysis(mockPool, { type: "sleep_quality" });
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("sleep_quality");
  });
});
