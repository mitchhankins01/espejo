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
  upsertOuraDailySpo2,
  upsertOuraDailyResilience,
  upsertOuraDailyCardiovascularAge,
  upsertOuraSleepTime,
  upsertOuraEnhancedTag,
  upsertOuraRestModePeriod,
  upsertOuraSession,
  insertOuraHeartrateBatch,
  getOuraSummaryByDay,
  getOuraWeeklyRows,
  getOuraTrendMetric,
  getOuraTrendMetricForRange,
  getOuraSleepDetailForRange,
  getOuraTemperatureData,
  getOuraIntraNightHrv,
  getOuraDailySpo2,
  getOuraResilience,
  getOuraCardiovascularAge,
  getOuraHeartrateRange,
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
  it("upserts sleep session data with sleep_type from row.type", async () => {
    const pool = mockPool();
    const row = {
      id: "session-1",
      day: "2025-01-15",
      period: 1,
      type: "long_sleep",
      bedtime_start: "2025-01-15T22:00:00Z",
      bedtime_end: "2025-01-16T06:00:00Z",
      average_hrv: 42,
      average_heart_rate: 60,
      total_sleep_duration: 28800,
      efficiency: 90,
    };
    await upsertOuraSleepSession(pool, row);
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_sleep_sessions"),
      expect.arrayContaining(["session-1"])
    );
    expect(args[3]).toBe("long_sleep");
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraSleepSession(pool, { id: "s-1", day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[2]).toBeNull(); // period
    expect(args[3]).toBeNull(); // sleep_type
    expect(args[4]).toBeNull(); // bedtime_start
    expect(args[6]).toBeNull(); // average_hrv
    expect(args[8]).toBeNull(); // lowest_heart_rate
    expect(args[14]).toBeNull(); // deep_sleep_seconds
  });

  it("promotes intra-night HRV/HR time series and stage durations from raw fields", async () => {
    const pool = mockPool();
    await upsertOuraSleepSession(pool, {
      id: "s-2", day: "2025-01-16", type: "long_sleep",
      lowest_heart_rate: 48, average_breath: 14.2,
      time_in_bed: 30000, awake_time: 1500, latency: 600,
      deep_sleep_duration: 5400, rem_sleep_duration: 7200, light_sleep_duration: 17000,
      restless_periods: 110,
      hrv: { interval: 300, items: [40, 42, null, 45] },
      heart_rate: { interval: 300, items: [55, 54, 53, 52] },
      sleep_phase_5_min: "2222333",
      sleep_phase_30_sec: "222233334",
      movement_30_sec: "111122",
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[8]).toBe(48); // lowest_heart_rate
    expect(args[14]).toBe(5400); // deep_sleep_seconds
    expect(args[15]).toBe(7200); // rem_sleep_seconds
    expect(args[19]).toEqual({ interval: 300, items: [40, 42, null, 45] }); // hrv_5min
    expect(args[21]).toBe("2222333"); // sleep_phase_5min
  });
});

describe("upsertOuraDailyReadiness", () => {
  it("upserts readiness data, sourcing scores from contributors", async () => {
    const pool = mockPool();
    await upsertOuraDailyReadiness(pool, {
      day: "2025-01-15",
      score: 80,
      temperature_deviation: 0.2,
      temperature_trend_deviation: 0.05,
      contributors: { resting_heart_rate: 92, hrv_balance: 78 },
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[0]).toBe("2025-01-15");
    expect(args[3]).toBe(0.05); // temperature_trend_deviation
    expect(args[4]).toBe(92); // resting_heart_rate_score
    expect(args[5]).toBe(78); // hrv_balance_score
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraDailyReadiness(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull(); // score
    expect(args[2]).toBeNull(); // temperature_deviation
    expect(args[3]).toBeNull(); // temperature_trend_deviation
    expect(args[4]).toBeNull(); // resting_heart_rate_score
    expect(args[5]).toBeNull(); // hrv_balance_score
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
      sedentary_time: 30000,
      resting_time: 14000,
      non_wear_time: 1500,
      medium_activity_time: 1800,
      high_activity_time: 600,
      low_activity_time: 3600,
      sedentary_met_minutes: 4,
      low_activity_met_minutes: 200,
      medium_activity_met_minutes: 800,
      high_activity_met_minutes: 80,
      average_met_minutes: 1.5,
      equivalent_walking_distance: 6500,
      class_5_min: "11122334",
      met: { interval: 60, items: [1, 1, 2] },
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[5]).toBe(30000); // sedentary_seconds
    expect(args[6]).toBe(14000); // resting_seconds
    expect(args[7]).toBe(1500); // non_wear_seconds
    expect(args[8]).toBe(1800); // medium_activity_seconds
    expect(args[9]).toBe(600); // high_activity_seconds
    expect(args[10]).toBe(3600); // low_activity_seconds
    expect(args[15]).toBe(1.5); // average_met_minutes
    expect(args[16]).toBe(6500); // equivalent_walking_distance_m
    expect(args[17]).toBe("11122334"); // class_5min
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraDailyActivity(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull(); // score
    expect(args[5]).toBeNull(); // sedentary_seconds
    expect(args[7]).toBeNull(); // non_wear_seconds
    expect(args[8]).toBeNull(); // medium_activity_seconds
    expect(args[18]).toBeNull(); // met
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
  it("upserts workout data and computes duration from start/end datetimes", async () => {
    const pool = mockPool();
    await upsertOuraWorkout(pool, {
      id: "workout-1",
      day: "2025-01-15",
      activity: "running",
      calories: 350,
      distance: 5000,
      start_datetime: "2025-01-15T08:00:00Z",
      end_datetime: "2025-01-15T08:30:00Z",
      intensity: "hard",
      label: null,
      source: "manual",
      average_heart_rate: 145,
      max_heart_rate: 170,
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[5]).toBe(1800); // computed duration_seconds (30 min)
    expect(args[6]).toBe("2025-01-15T08:00:00Z"); // start_time
    expect(args[8]).toBe("hard"); // intensity
    expect(args[10]).toBe("manual"); // source
    expect(args[11]).toBe(145); // average_heart_rate
  });

  it("handles missing optional fields with null fallback", async () => {
    const pool = mockPool();
    await upsertOuraWorkout(pool, { id: "w-1", day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[2]).toBeNull(); // activity
    expect(args[3]).toBeNull(); // calories
    expect(args[5]).toBeNull(); // duration_seconds (no start/end)
    expect(args[12]).toBeNull(); // max_heart_rate
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
    const metrics = ["sleep_score", "hrv", "readiness", "activity", "steps", "sleep_duration", "stress", "resting_heart_rate", "temperature", "active_calories", "heart_rate", "efficiency"] as const;
    for (const metric of metrics) {
      const pool = mockPool([]);
      await getOuraTrendMetric(pool, metric, 30);
      expect(pool.query).toHaveBeenCalledOnce();
    }
  });

  it("includes stress join for stress metric", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetric(pool, "stress", 30);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_daily_stress"),
      [30]
    );
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

  it("includes stress join for stress metric", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetricForRange(pool, "stress", "2025-01-01", "2025-01-15");
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_daily_stress"),
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

describe("upsertOuraDailySpo2", () => {
  it("extracts average_spo2 from spo2_percentage object", async () => {
    const pool = mockPool();
    await upsertOuraDailySpo2(pool, {
      day: "2025-01-15",
      spo2_percentage: { average: 97.2 },
      breathing_disturbance_index: 4,
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[0]).toBe("2025-01-15");
    expect(args[1]).toBe(97.2);
    expect(args[2]).toBe(4);
  });

  it("handles missing fields", async () => {
    const pool = mockPool();
    await upsertOuraDailySpo2(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull();
  });
});

describe("upsertOuraDailyResilience", () => {
  it("extracts level + contributors", async () => {
    const pool = mockPool();
    await upsertOuraDailyResilience(pool, {
      day: "2025-01-15",
      level: "solid",
      contributors: { sleep_recovery: 54.2, daytime_recovery: 48.6, stress: 59.4 },
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBe("solid");
    expect(args[2]).toBe(54.2);
    expect(args[3]).toBe(48.6);
    expect(args[4]).toBe(59.4);
  });

  it("handles missing contributors", async () => {
    const pool = mockPool();
    await upsertOuraDailyResilience(pool, { day: "2025-01-15", level: "limited" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[2]).toBeNull();
  });
});

describe("upsertOuraDailyCardiovascularAge", () => {
  it("upserts vascular_age + pulse_wave_velocity", async () => {
    const pool = mockPool();
    await upsertOuraDailyCardiovascularAge(pool, {
      day: "2025-01-15",
      vascular_age: 37,
      pulse_wave_velocity: 6.95,
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBe(37);
    expect(args[2]).toBe(6.95);
  });
});

describe("upsertOuraSleepTime", () => {
  it("upserts optimal bedtime recommendation", async () => {
    const pool = mockPool();
    await upsertOuraSleepTime(pool, {
      day: "2025-01-15",
      status: "optimal_found",
      recommendation: "follow_optimal_bedtime",
      optimal_bedtime: { day_tz: 7200, end_offset: -4500, start_offset: -9900 },
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_sleep_time"),
      expect.arrayContaining(["2025-01-15", "optimal_found"])
    );
  });
});

describe("upsertOuraEnhancedTag", () => {
  it("upserts manual tag with comment", async () => {
    const pool = mockPool();
    await upsertOuraEnhancedTag(pool, {
      id: "tag-1",
      start_day: "2025-01-15",
      end_day: "2025-01-15",
      start_time: "2025-01-15T18:00:00Z",
      end_time: "2025-01-15T19:00:00Z",
      tag_type_code: "alcohol",
      custom_name: "wine",
      comment: "two glasses",
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[0]).toBe("tag-1");
    expect(args[5]).toBe("alcohol");
    expect(args[7]).toBe("two glasses");
  });
});

describe("upsertOuraRestModePeriod", () => {
  it("upserts rest mode window", async () => {
    const pool = mockPool();
    await upsertOuraRestModePeriod(pool, {
      id: 1,
      start_day: "2025-01-15",
      end_day: "2025-01-17",
      episodes: [{ tags: ["sick"], timestamp: "2025-01-15T08:00:00Z" }],
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[0]).toBe(1);
    expect(args[1]).toBe("2025-01-15");
  });
});

describe("upsertOuraSession", () => {
  it("upserts a meditation session with HRV time series", async () => {
    const pool = mockPool();
    await upsertOuraSession(pool, {
      id: "med-1",
      day: "2025-01-15",
      type: "meditation",
      start_datetime: "2025-01-15T05:30:00Z",
      end_datetime: "2025-01-15T06:30:00Z",
      mood: "great",
      motion_count: { interval: 5, items: [0, 1, 0] },
      hrv: { interval: 5, items: [60, 65, 70] },
      heart_rate: { interval: 5, items: [55, 54, 53] },
    });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[0]).toBe("med-1");
    expect(args[2]).toBe("meditation");
    expect(args[7]).toEqual({ interval: 5, items: [60, 65, 70] }); // hrv
  });
});

describe("insertOuraHeartrateBatch", () => {
  it("returns 0 for empty batch and skips DB", async () => {
    const pool = mockPool();
    const inserted = await insertOuraHeartrateBatch(pool, []);
    expect(inserted).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("inserts batch with positional placeholders", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 2 }) } as unknown as pg.Pool;
    const inserted = await insertOuraHeartrateBatch(pool, [
      { ts: "2025-01-15T05:00:00Z", bpm: 56, source: "rest" },
      { ts: "2025-01-15T05:05:00Z", bpm: 58, source: "rest" },
    ]);
    expect(inserted).toBe(2);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("oura_heartrate"),
      expect.arrayContaining(["2025-01-15T05:00:00Z", 56, "rest"])
    );
  });

  it("returns 0 when rowCount is null (driver edge case)", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: null }) } as unknown as pg.Pool;
    const inserted = await insertOuraHeartrateBatch(pool, [
      { ts: "2025-01-15T05:00:00Z", bpm: 56, source: "rest" },
    ]);
    expect(inserted).toBe(0);
  });
});

describe("getOuraIntraNightHrv", () => {
  it("returns the long_sleep session HRV time series", async () => {
    const pool = mockPool([{ day: new Date("2025-01-15"), hrv_5min: { interval: 300, items: [40, 42] } }]);
    const result = await getOuraIntraNightHrv(pool, "2025-01-15");
    expect(result?.hrv_5min?.items).toEqual([40, 42]);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("sleep_type = 'long_sleep'"),
      ["2025-01-15"]
    );
  });

  it("returns null when no long_sleep on the day", async () => {
    const pool = mockPool([]);
    const result = await getOuraIntraNightHrv(pool, "2020-01-01");
    expect(result).toBeNull();
  });
});

describe("getOuraDailySpo2 / getOuraResilience / getOuraCardiovascularAge", () => {
  it("returns spo2 row", async () => {
    const pool = mockPool([{ day: new Date("2025-01-15"), average_spo2: 97.2, breathing_disturbance_index: 4 }]);
    const r = await getOuraDailySpo2(pool, "2025-01-15");
    expect(r?.average_spo2).toBe(97.2);
  });

  it("returns null when spo2 missing", async () => {
    expect(await getOuraDailySpo2(mockPool([]), "x")).toBeNull();
  });

  it("returns resilience row", async () => {
    const pool = mockPool([{ day: new Date("2025-01-15"), level: "solid" }]);
    const r = await getOuraResilience(pool, "2025-01-15");
    expect(r?.level).toBe("solid");
  });

  it("returns null when resilience missing", async () => {
    expect(await getOuraResilience(mockPool([]), "x")).toBeNull();
  });

  it("returns cardiovascular age row", async () => {
    const pool = mockPool([{ day: new Date("2025-01-15"), vascular_age: 37, pulse_wave_velocity: 6.95 }]);
    const r = await getOuraCardiovascularAge(pool, "2025-01-15");
    expect(r?.vascular_age).toBe(37);
  });

  it("returns null when cv age missing", async () => {
    expect(await getOuraCardiovascularAge(mockPool([]), "x")).toBeNull();
  });
});

describe("getOuraHeartrateRange", () => {
  it("queries without source filter", async () => {
    const pool = mockPool([]);
    await getOuraHeartrateRange(pool, "2025-01-15T00:00:00Z", "2025-01-15T01:00:00Z");
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("oura_heartrate");
    expect(sql).not.toContain("source =");
  });

  it("queries with source filter", async () => {
    const pool = mockPool([]);
    await getOuraHeartrateRange(pool, "2025-01-15T00:00:00Z", "2025-01-15T01:00:00Z", "rest");
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("source = $3");
  });
});

describe("getOuraTrendMetric — joinClausesFor coverage", () => {
  it("includes spo2 join for spo2 metric", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetric(pool, "spo2", 30);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("oura_daily_spo2");
  });

  it("includes resilience join for resilience metric", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetric(pool, "resilience_sleep_recovery", 30);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("oura_daily_resilience");
  });

  it("includes cv_age join for vascular_age metric", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetric(pool, "vascular_age", 30);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("oura_daily_cardiovascular_age");
  });

  it("includes cv_age join for pulse_wave_velocity metric", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetric(pool, "pulse_wave_velocity", 30);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("oura_daily_cardiovascular_age");
  });

  it("uses sleep session lowest_heart_rate for resting_heart_rate metric", async () => {
    const pool = mockPool([]);
    await getOuraTrendMetric(pool, "resting_heart_rate", 30);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toContain("ss.lowest_heart_rate");
  });
});

describe("upsert null-fallback coverage", () => {
  it("upsertOuraDailyResilience handles missing fields", async () => {
    const pool = mockPool();
    await upsertOuraDailyResilience(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull();
    expect(args[2]).toBeNull();
    expect(args[3]).toBeNull();
    expect(args[4]).toBeNull();
  });

  it("upsertOuraDailyCardiovascularAge handles missing fields", async () => {
    const pool = mockPool();
    await upsertOuraDailyCardiovascularAge(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull();
    expect(args[2]).toBeNull();
  });

  it("upsertOuraSleepTime handles missing fields", async () => {
    const pool = mockPool();
    await upsertOuraSleepTime(pool, { day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull();
    expect(args[2]).toBeNull();
    expect(args[3]).toBeNull();
  });

  it("upsertOuraEnhancedTag handles missing fields", async () => {
    const pool = mockPool();
    await upsertOuraEnhancedTag(pool, { id: "t-1" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull();
    expect(args[2]).toBeNull();
    expect(args[3]).toBeNull();
    expect(args[4]).toBeNull();
    expect(args[5]).toBeNull();
    expect(args[6]).toBeNull();
    expect(args[7]).toBeNull();
  });

  it("upsertOuraRestModePeriod handles missing fields", async () => {
    const pool = mockPool();
    await upsertOuraRestModePeriod(pool, { id: 99 });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[1]).toBeNull();
    expect(args[2]).toBeNull();
    expect(args[3]).toBeNull();
  });

  it("upsertOuraSession handles missing fields", async () => {
    const pool = mockPool();
    await upsertOuraSession(pool, { id: "med-x", day: "2025-01-15" });
    const args = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(args[2]).toBeNull(); // type
    expect(args[3]).toBeNull(); // start_time
    expect(args[4]).toBeNull(); // end_time
    expect(args[5]).toBeNull(); // mood
    expect(args[6]).toBeNull(); // motion_count
    expect(args[7]).toBeNull(); // hrv
    expect(args[8]).toBeNull(); // heart_rate
  });
});
