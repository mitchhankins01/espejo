import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  insertOuraSyncRun: vi.fn().mockResolvedValue(1),
  completeOuraSyncRun: vi.fn().mockResolvedValue(undefined),
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

import { runOuraSync, notifyOuraSync, startOuraSyncTimer } from "../../src/oura/sync.js";

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
  for (const fn of Object.values(mockClientInstance)) fn.mockClear().mockResolvedValue([]);
  mockQueries.insertOuraSyncRun.mockResolvedValue(1);
  mockConfig.config.oura.accessToken = "test-token";
  mockConfig.config.telegram.botToken = "test-bot-token";
  mockConfig.config.telegram.allowedChatId = "100";
  mockSendTelegramMessage.mockReset().mockResolvedValue(undefined);
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
  it("sends message with inline keyboard", () => {
    notifyOuraSync({
      runId: 42,
      total: 368,
      counts: { sleep: 31, sessions: 72, readiness: 31, activity: 30, stress: 31, workouts: 173 },
      durationMs: 8000,
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("368 records"),
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ text: "Details", callback_data: expect.stringContaining("oura_sync:42:") }),
          ]),
        ]),
      })
    );
  });

  it("includes duration in seconds", () => {
    notifyOuraSync({
      runId: 1,
      total: 10,
      counts: { sleep: 1, sessions: 2, readiness: 1, activity: 2, stress: 2, workouts: 2 },
      durationMs: 3500,
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("4s"),
      expect.anything()
    );
  });

  it("skips when no botToken", () => {
    mockConfig.config.telegram.botToken = "";
    notifyOuraSync({
      runId: 1,
      total: 10,
      counts: { sleep: 1, sessions: 2, readiness: 1, activity: 2, stress: 2, workouts: 2 },
      durationMs: 1000,
    });

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips when no allowedChatId", () => {
    mockConfig.config.telegram.allowedChatId = "";
    notifyOuraSync({
      runId: 1,
      total: 10,
      counts: { sleep: 1, sessions: 2, readiness: 1, activity: 2, stress: 2, workouts: 2 },
      durationMs: 1000,
    });

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
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
