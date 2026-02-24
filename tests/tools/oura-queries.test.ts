import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import {
  insertOuraSyncRun,
  completeOuraSyncRun,
  upsertOuraSyncState,
  upsertOuraDailySleep,
  upsertOuraSleepSession,
  upsertOuraDailyReadiness,
  upsertOuraDailyActivity,
  upsertOuraDailyStress,
  upsertOuraWorkout,
  getOuraSummaryByDay,
  getOuraWeeklyRows,
  getOuraTrendMetric,
  getOuraTrendMetricForRange,
  getOuraSleepDetailForRange,
  getOuraTemperatureData,
} from "../../src/db/queries.js";

function mockPool(rows: unknown[] = []): pg.Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as pg.Pool;
}

describe("insertOuraSyncRun", () => {
  it("returns inserted run id", async () => {
    const pool = mockPool([{ id: 42 }]);
    const id = await insertOuraSyncRun(pool);
    expect(id).toBe(42);
    expect(pool.query).toHaveBeenCalledOnce();
  });
});

describe("completeOuraSyncRun", () => {
  it("updates sync run with status", async () => {
    const pool = mockPool();
    await completeOuraSyncRun(pool, 1, "success", 10, null);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE oura_sync_runs"),
      [1, "success", 10, null]
    );
  });
});

describe("upsertOuraSyncState", () => {
  it("upserts sync state", async () => {
    const pool = mockPool();
    await upsertOuraSyncState(pool, "all", "2025-01-15");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_sync_state"),
      ["all", "2025-01-15"]
    );
  });
});

describe("upsertOuraDailySleep", () => {
  it("upserts daily sleep data", async () => {
    const pool = mockPool();
    const row = {
      day: "2025-01-15",
      score: 85,
      total_sleep_duration: 28800,
      deep_sleep_duration: 7200,
      rem_sleep_duration: 5400,
      light_sleep_duration: 16200,
      efficiency: 90,
      contributors: { deep_sleep: 80 },
    };
    await upsertOuraDailySleep(pool, row);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_daily_sleep"),
      expect.arrayContaining(["2025-01-15", 85])
    );
  });

  it("handles missing optional fields", async () => {
    const pool = mockPool();
    await upsertOuraDailySleep(pool, { day: "2025-01-15" });
    expect(pool.query).toHaveBeenCalledOnce();
  });
});

describe("upsertOuraSleepSession", () => {
  it("upserts sleep session data", async () => {
    const pool = mockPool();
    const row = {
      id: "session-1",
      day: "2025-01-15",
      period: 0,
      bedtime_start: "2025-01-15T22:00:00Z",
      bedtime_end: "2025-01-16T06:00:00Z",
      average_hrv: 42,
      average_heart_rate: 60,
      total_sleep_duration: 28800,
      efficiency: 90,
    };
    await upsertOuraSleepSession(pool, row);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_sleep_sessions"),
      expect.arrayContaining(["session-1"])
    );
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraSleepSession(pool, { id: "s-1", day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    // period, bedtime_start, bedtime_end, average_hrv, average_heart_rate, total_sleep_duration, efficiency → null
    expect(args[2]).toBeNull(); // period
    expect(args[3]).toBeNull(); // bedtime_start
    expect(args[5]).toBeNull(); // average_hrv
  });
});

describe("upsertOuraDailyReadiness", () => {
  it("upserts readiness data", async () => {
    const pool = mockPool();
    await upsertOuraDailyReadiness(pool, {
      day: "2025-01-15",
      score: 80,
      temperature_deviation: 0.2,
      resting_heart_rate: 55,
      hrv_balance: 45,
      contributors: {},
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_daily_readiness"),
      expect.arrayContaining(["2025-01-15", 80])
    );
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraDailyReadiness(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull(); // score
    expect(args[2]).toBeNull(); // temperature_deviation
    expect(args[5]).toBeNull(); // contributors
  });
});

describe("upsertOuraDailyActivity", () => {
  it("maps activity field names correctly", async () => {
    const pool = mockPool();
    await upsertOuraDailyActivity(pool, {
      day: "2025-01-15",
      score: 75,
      steps: 8000,
      active_calories: 400,
      total_calories: 2200,
      medium_activity_time: 1800,
      high_activity_time: 600,
      low_activity_time: 3600,
    });
    const callArgs = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    // medium_activity_time should map to position 5
    expect(callArgs[5]).toBe(1800);
    expect(callArgs[6]).toBe(600);
    expect(callArgs[7]).toBe(3600);
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraDailyActivity(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull(); // score
    expect(args[2]).toBeNull(); // steps
    expect(args[5]).toBeNull(); // medium_activity_time
  });
});

describe("upsertOuraDailyStress", () => {
  it("upserts stress data", async () => {
    const pool = mockPool();
    await upsertOuraDailyStress(pool, {
      day: "2025-01-15",
      stress_high: 3600,
      recovery_high: 7200,
      day_summary: "normal",
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_daily_stress"),
      expect.arrayContaining(["2025-01-15"])
    );
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraDailyStress(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull(); // stress_high
    expect(args[3]).toBeNull(); // day_summary
  });
});

describe("upsertOuraWorkout", () => {
  it("upserts workout data", async () => {
    const pool = mockPool();
    await upsertOuraWorkout(pool, {
      id: "workout-1",
      day: "2025-01-15",
      activity: "running",
      calories: 350,
      distance: 5000,
      duration: 1800,
      average_heart_rate: 145,
      max_heart_rate: 170,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_workouts"),
      expect.arrayContaining(["workout-1"])
    );
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraWorkout(pool, { id: "w-1", day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[2]).toBeNull(); // activity
    expect(args[3]).toBeNull(); // calories
    expect(args[7]).toBeNull(); // max_heart_rate
  });
});

describe("getOuraSummaryByDay", () => {
  it("returns summary for a day", async () => {
    const pool = mockPool([{ day: "2025-01-15", sleep_score: 85 }]);
    const result = await getOuraSummaryByDay(pool, "2025-01-15");
    expect(result).toEqual({ day: "2025-01-15", sleep_score: 85 });
  });

  it("returns null when no data", async () => {
    const pool = mockPool([]);
    const result = await getOuraSummaryByDay(pool, "2020-01-01");
    expect(result).toBeNull();
  });
});

describe("getOuraWeeklyRows", () => {
  it("returns weekly rows", async () => {
    const pool = mockPool([{ day: "2025-01-15" }, { day: "2025-01-14" }]);
    const result = await getOuraWeeklyRows(pool, "2025-01-15");
    expect(result).toHaveLength(2);
  });
});

describe("getOuraTrendMetric", () => {
  it("queries trend data for a metric", async () => {
    const pool = mockPool([{ day: new Date("2025-01-15"), value: 85 }]);
    const result = await getOuraTrendMetric(pool, "sleep_score", 30);
    expect(result).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("d.score"),
      [30]
    );
  });

  it("handles all metric types", async () => {
    const metrics = ["sleep_score", "hrv", "readiness", "activity", "steps", "sleep_duration"] as const;
    for (const metric of metrics) {
      const pool = mockPool([]);
      await getOuraTrendMetric(pool, metric, 30);
      expect(pool.query).toHaveBeenCalledOnce();
    }
  });
});

describe("getOuraTrendMetricForRange", () => {
  it("queries trend data for a date range", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetricForRange(pool, "hrv", "2025-01-01", "2025-01-15");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("ss.average_hrv"),
      ["2025-01-01", "2025-01-15"]
    );
  });
});

describe("getOuraSleepDetailForRange", () => {
  it("queries sleep detail data", async () => {
    const pool = mockPool([]);
    await getOuraSleepDetailForRange(pool, 30);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_daily_sleep"),
      [30]
    );
  });
});

describe("getOuraTemperatureData", () => {
  it("queries temperature data", async () => {
    const pool = mockPool([]);
    await getOuraTemperatureData(pool, 30);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("temperature_deviation"),
      [30]
    );
  });
});
