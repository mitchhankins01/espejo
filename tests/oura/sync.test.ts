import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  insertOuraSyncRun: vi.fn().mockResolvedValue(1),
  completeOuraSyncRun: vi.fn().mockResolvedValue(undefined),
  getOuraSummaryByDay: vi.fn().mockResolvedValue(null),
  getOuraTrendMetric: vi.fn().mockResolvedValue([]),
  upsertOuraDailySleep: vi.fn().mockResolvedValue(undefined),
  upsertOuraSleepSession: vi.fn().mockResolvedValue(undefined),
  upsertOuraDailyReadiness: vi.fn().mockResolvedValue(undefined),
  upsertOuraDailyActivity: vi.fn().mockResolvedValue(undefined),
  upsertOuraDailyStress: vi.fn().mockResolvedValue(undefined),
  upsertOuraWorkout: vi.fn().mockResolvedValue(undefined),
  upsertOuraSyncState: vi.fn().mockResolvedValue(undefined),
}));

const mockSendTelegramMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockConfig = vi.hoisted(() => ({
  config: {
    oura: { accessToken: "test-token", syncIntervalMinutes: 60, syncLookbackDays: 7 },
    telegram: { botToken: "test-bot-token", allowedChatId: "100" },
    timezone: "Europe/Madrid",
  },
}));

const mockClientInstance = vi.hoisted(() => ({
  getDailySleep: vi.fn().mockResolvedValue([]),
  getSleepSessions: vi.fn().mockResolvedValue([]),
  getDailyReadiness: vi.fn().mockResolvedValue([]),
  getDailyActivity: vi.fn().mockResolvedValue([]),
  getDailyStress: vi.fn().mockResolvedValue([]),
  getWorkouts: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);
vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));
vi.mock("../../src/telegram/notify.js", () => ({
  notifyError: vi.fn(),
}));
vi.mock("../../src/oura/client.js", () => ({
  OuraClient: class {
    getDailySleep = mockClientInstance.getDailySleep;
    getSleepSessions = mockClientInstance.getSleepSessions;
    getDailyReadiness = mockClientInstance.getDailyReadiness;
    getDailyActivity = mockClientInstance.getDailyActivity;
    getDailyStress = mockClientInstance.getDailyStress;
    getWorkouts = mockClientInstance.getWorkouts;
  },
}));

import { runOuraSync, notifyOuraSync, startOuraSyncTimer, buildOuraSyncInsight, _resetLastSentInsight } from "../../src/oura/sync.js";

function makeMockPool(lockResult = true): any {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ ok: lockResult }] });
      }
      if (sql.includes("pg_advisory_unlock")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const fn of Object.values(mockQueries)) fn.mockClear();
  mockQueries.getOuraSummaryByDay.mockResolvedValue(null);
  mockQueries.getOuraTrendMetric.mockResolvedValue([]);
  for (const fn of Object.values(mockClientInstance)) fn.mockClear().mockResolvedValue([]);
  mockQueries.insertOuraSyncRun.mockResolvedValue(1);
  mockConfig.config.oura.accessToken = "test-token";
  mockConfig.config.telegram.botToken = "test-bot-token";
  mockConfig.config.telegram.allowedChatId = "100";
  mockSendTelegramMessage.mockReset().mockResolvedValue(undefined);
  _resetLastSentInsight();
});

describe("runOuraSync", () => {
  it("skips when no access token", async () => {
    mockConfig.config.oura.accessToken = "";
    const pool = makeMockPool();
    const result = await runOuraSync(pool, 7);
    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips when advisory lock is not acquired", async () => {
    const pool = makeMockPool(false);
    const result = await runOuraSync(pool, 7);
    expect(result).toBeNull();
    expect(mockQueries.insertOuraSyncRun).not.toHaveBeenCalled();
  });

  it("fetches all endpoints and upserts data", async () => {
    mockClientInstance.getDailySleep.mockResolvedValue([{ day: "2025-01-15" }]);
    mockClientInstance.getSleepSessions.mockResolvedValue([{ day: "2025-01-15", id: "s1" }]);
    mockClientInstance.getDailyReadiness.mockResolvedValue([{ day: "2025-01-15" }]);
    mockClientInstance.getDailyActivity.mockResolvedValue([{ day: "2025-01-15" }]);
    mockClientInstance.getDailyStress.mockResolvedValue([{ day: "2025-01-15" }]);
    mockClientInstance.getWorkouts.mockResolvedValue([{ day: "2025-01-15" }]);

    const pool = makeMockPool();
    const result = await runOuraSync(pool, 7);

    expect(result).not.toBeNull();
    expect(result!.total).toBe(6);
    expect(result!.counts.sleep).toBe(1);
    expect(result!.runId).toBe(1);
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockQueries.insertOuraSyncRun).toHaveBeenCalledOnce();
    expect(mockQueries.upsertOuraDailySleep).toHaveBeenCalledOnce();
    expect(mockQueries.upsertOuraSleepSession).toHaveBeenCalledOnce();
    expect(mockQueries.upsertOuraDailyReadiness).toHaveBeenCalledOnce();
    expect(mockQueries.upsertOuraDailyActivity).toHaveBeenCalledOnce();
    expect(mockQueries.upsertOuraDailyStress).toHaveBeenCalledOnce();
    expect(mockQueries.upsertOuraWorkout).toHaveBeenCalledOnce();
    expect(mockQueries.upsertOuraSyncState).toHaveBeenCalledOnce();
    expect(mockQueries.completeOuraSyncRun).toHaveBeenCalledWith(
      pool, 1, "success", 6, null
    );
  });

  it("records failure and rethrows on error", async () => {
    mockClientInstance.getDailySleep.mockRejectedValue(new Error("API down"));
    const pool = makeMockPool();
    await expect(runOuraSync(pool, 7)).rejects.toThrow("API down");
    expect(mockQueries.completeOuraSyncRun).toHaveBeenCalledWith(
      pool, 1, "failed", 0, "API down"
    );
    // Advisory lock should be released
    expect(pool.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      [9152201]
    );
  });

  it("records 'Unknown Oura sync error' for non-Error throws", async () => {
    mockClientInstance.getDailySleep.mockRejectedValue("string-error");
    const pool = makeMockPool();
    await expect(runOuraSync(pool, 7)).rejects.toBe("string-error");
    expect(mockQueries.completeOuraSyncRun).toHaveBeenCalledWith(
      pool, 1, "failed", 0, "Unknown Oura sync error"
    );
  });

  it("always releases advisory lock even on success", async () => {
    const pool = makeMockPool();
    await runOuraSync(pool, 7);
    expect(pool.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      [9152201]
    );
  });
});

describe("notifyOuraSync", () => {
  it("skips notification when no insight is provided", () => {
    notifyOuraSync({
      runId: 42,
      total: 368,
      counts: { sleep: 31, sessions: 72, readiness: 31, activity: 30, stress: 31, workouts: 173 },
      durationMs: 8000,
    });

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends insight with inline keyboard and updated summary", () => {
    notifyOuraSync(
      {
        runId: 3,
        total: 1,
        counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 1, workouts: 0 },
        durationMs: 1000,
      },
      "Stress is up 45m vs yesterday. Keep today lighter and add a recovery block."
    );

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Oura sync insight: Stress is up 45m vs yesterday."),
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ text: "Details", callback_data: expect.stringContaining("oura_sync:3:") }),
          ]),
        ]),
      })
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Updated: stress 1"),
      expect.anything()
    );
  });

  it("includes only non-zero updated datasets in summary", () => {
    notifyOuraSync(
      {
        runId: 1,
        total: 3,
        counts: { sleep: 1, sessions: 0, readiness: 0, activity: 2, stress: 0, workouts: 0 },
        durationMs: 3500,
      },
      "Sleep dropped 60m vs yesterday. Aim for an earlier wind-down tonight."
    );

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Updated: sleep 1, activity 2"),
      expect.anything()
    );
  });

  it("uses 'no data changes' in summary when all counts are zero", () => {
    notifyOuraSync(
      {
        runId: 2,
        total: 0,
        counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0 },
        durationMs: 1000,
      },
      "Recovery looks strong (sleep 450m, readiness 84). Good day for focused effort."
    );

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("no data changes"),
      expect.anything()
    );
  });

  it("skips when no botToken", () => {
    mockConfig.config.telegram.botToken = "";
    notifyOuraSync(
      {
        runId: 1,
        total: 10,
        counts: { sleep: 1, sessions: 2, readiness: 1, activity: 2, stress: 2, workouts: 2 },
        durationMs: 1000,
      },
      "Some insight"
    );

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips when no allowedChatId", () => {
    mockConfig.config.telegram.allowedChatId = "";
    notifyOuraSync(
      {
        runId: 1,
        total: 10,
        counts: { sleep: 1, sessions: 2, readiness: 1, activity: 2, stress: 2, workouts: 2 },
        durationMs: 1000,
      },
      "Some insight"
    );

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("suppresses duplicate insight on consecutive calls", () => {
    const result = {
      runId: 5,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 1, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    };
    const insight = "Readiness is down 12 points vs yesterday. Keep effort moderate and prioritize rest.";

    notifyOuraSync(result, insight);
    notifyOuraSync({ ...result, runId: 6 }, insight);

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("sends again when insight text changes", () => {
    const result = {
      runId: 7,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 1, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    };

    notifyOuraSync(result, "Readiness is down 12 points vs yesterday. Keep effort moderate and prioritize rest.");
    notifyOuraSync({ ...result, runId: 8 }, "Readiness is up 5 points vs yesterday. Good window for focused work or training.");

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(2);
  });
});

describe("startOuraSyncTimer", () => {
  it("returns null when no access token", () => {
    mockConfig.config.oura.accessToken = "";
    const pool = makeMockPool();
    const timer = startOuraSyncTimer(pool);
    expect(timer).toBeNull();
  });

  it("starts a timer when access token is present", () => {
    vi.useFakeTimers();
    const pool = makeMockPool();
    const timer = startOuraSyncTimer(pool);
    expect(timer).not.toBeNull();
    clearInterval(timer!);
    vi.useRealTimers();
  });
});

describe("buildOuraSyncInsight", () => {
  it("returns stress increase guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 3600 },
      { day: new Date("2025-01-15"), value: 7200 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 10,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 1, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Stress is up 60m vs yesterday");
    expect(mockQueries.getOuraTrendMetric).toHaveBeenCalledWith(
      expect.anything(),
      "stress",
      2
    );
  });

  it("returns stress decrease guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 7200 },
      { day: new Date("2025-01-15"), value: 3600 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 24,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 1, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Stress is down 60m");
  });

  it("ignores non-finite trend values", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: Number.NaN },
      { day: new Date("2025-01-15"), value: 3600 },
    ]);
    mockQueries.getOuraSummaryByDay.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 25,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 1, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toBeNull();
  });

  it("returns sleep decrease guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 28_800 },
      { day: new Date("2025-01-15"), value: 25_200 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 18,
      total: 1,
      counts: { sleep: 1, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Sleep dropped 60m");
  });

  it("returns sleep increase guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 25_200 },
      { day: new Date("2025-01-15"), value: 28_800 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 19,
      total: 1,
      counts: { sleep: 1, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Sleep increased 60m");
  });

  it("returns HRV decrease guidance when sleep delta is non-actionable", async () => {
    mockQueries.getOuraTrendMetric
      .mockResolvedValueOnce([
        { day: new Date("2025-01-14"), value: 25_200 },
        { day: new Date("2025-01-15"), value: 25_800 },
      ])
      .mockResolvedValueOnce([
        { day: new Date("2025-01-14"), value: 50 },
        { day: new Date("2025-01-15"), value: 42 },
      ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 20,
      total: 1,
      counts: { sleep: 1, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("HRV is down 8ms");
  });

  it("returns HRV increase guidance when sleep delta is non-actionable", async () => {
    mockQueries.getOuraTrendMetric
      .mockResolvedValueOnce([
        { day: new Date("2025-01-14"), value: 25_200 },
        { day: new Date("2025-01-15"), value: 25_800 },
      ])
      .mockResolvedValueOnce([
        { day: new Date("2025-01-14"), value: 42 },
        { day: new Date("2025-01-15"), value: 52 },
      ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 21,
      total: 1,
      counts: { sleep: 1, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("HRV is up 10ms");
  });

  it("returns readiness decrease guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 80 },
      { day: new Date("2025-01-15"), value: 72 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 22,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 1, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Readiness is down 8 points");
  });

  it("returns readiness increase guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 72 },
      { day: new Date("2025-01-15"), value: 80 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 23,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 1, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Readiness is up 8 points");
  });

  it("falls back to readiness guidance when trend delta is unavailable", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([]);
    mockQueries.getOuraSummaryByDay.mockResolvedValueOnce({
      day: new Date("2025-01-15"),
      sleep_score: 72,
      readiness_score: 66,
      activity_score: 75,
      steps: 7000,
      stress: "normal",
      average_hrv: 42,
      average_heart_rate: 58,
      sleep_duration_seconds: 25200,
      deep_sleep_duration_seconds: 6000,
      rem_sleep_duration_seconds: 5400,
      efficiency: 90,
      workout_count: 1,
    });

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 11,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 1, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Readiness is 66");
  });

  it("falls back to step guidance when steps are low", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([]);
    mockQueries.getOuraSummaryByDay.mockResolvedValueOnce({
      day: new Date("2025-01-15"),
      sleep_score: 72,
      readiness_score: 75,
      activity_score: 65,
      steps: 5200,
      stress: "normal",
      average_hrv: 40,
      average_heart_rate: 60,
      sleep_duration_seconds: 24000,
      deep_sleep_duration_seconds: 5000,
      rem_sleep_duration_seconds: 5000,
      efficiency: 88,
      workout_count: 0,
    });

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 12,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 1, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Steps are 5200");
  });

  it("returns steps decrease guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 9000 },
      { day: new Date("2025-01-15"), value: 5800 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 15,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 1, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Steps are down 3200");
  });

  it("returns steps increase guidance from trend delta", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 6000 },
      { day: new Date("2025-01-15"), value: 9100 },
    ]);

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 16,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 1, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Steps are up 3100");
  });

  it("falls through non-actionable delta to sleep fallback guidance", async () => {
    mockQueries.getOuraTrendMetric.mockResolvedValueOnce([
      { day: new Date("2025-01-14"), value: 7000 },
      { day: new Date("2025-01-15"), value: 7300 },
    ]);
    mockQueries.getOuraSummaryByDay.mockResolvedValueOnce({
      day: new Date("2025-01-15"),
      sleep_score: 68,
      readiness_score: 74,
      activity_score: 64,
      steps: 7300,
      stress: "normal",
      average_hrv: 41,
      average_heart_rate: 61,
      sleep_duration_seconds: 22000,
      deep_sleep_duration_seconds: 4700,
      rem_sleep_duration_seconds: 4800,
      efficiency: 86,
      workout_count: 0,
    });

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 17,
      total: 1,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 1, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Sleep is under 6.5h");
  });

  it("uses strong recovery fallback when sleep/readiness are high", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValueOnce({
      day: new Date("2025-01-15"),
      sleep_score: 89,
      readiness_score: 84,
      activity_score: 81,
      steps: 9100,
      stress: "normal",
      average_hrv: 55,
      average_heart_rate: 52,
      sleep_duration_seconds: 27000,
      deep_sleep_duration_seconds: 6200,
      rem_sleep_duration_seconds: 6400,
      efficiency: 93,
      workout_count: 1,
    });

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 13,
      total: 0,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toContain("Recovery looks strong");
  });

  it("returns null when no trend or fallback trigger is present", async () => {
    mockQueries.getOuraSummaryByDay
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        day: new Date("2025-01-14"),
        sleep_score: 75,
        readiness_score: 74,
        activity_score: 76,
        steps: 7000,
        stress: "normal",
        average_hrv: 46,
        average_heart_rate: 56,
        sleep_duration_seconds: 24000,
        deep_sleep_duration_seconds: 5400,
        rem_sleep_duration_seconds: 5600,
        efficiency: 89,
        workout_count: 0,
      });

    const insight = await buildOuraSyncInsight(makeMockPool(), {
      runId: 14,
      total: 0,
      counts: { sleep: 0, sessions: 0, readiness: 0, activity: 0, stress: 0, workouts: 0 },
      durationMs: 1000,
    });

    expect(insight).toBeNull();
  });
});
