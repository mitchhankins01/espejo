import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  countInsightsNotifiedToday: vi.fn().mockResolvedValue(0),
  findTemporalEchoes: vi.fn().mockResolvedValue([]),
  getOuraSummaryByDay: vi.fn().mockResolvedValue(null),
  getEntriesByDateRange: vi.fn().mockResolvedValue([]),
  findStaleTodos: vi.fn().mockResolvedValue([]),
  insightHashExists: vi.fn().mockResolvedValue(false),
  insertInsight: vi.fn().mockResolvedValue(1),
  markInsightNotified: vi.fn().mockResolvedValue(undefined),
}));

const mockSendTelegramMessage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockConfig = vi.hoisted(() => ({
  config: {
    telegram: { botToken: "test-bot-token", allowedChatId: "100" },
    insights: {
      intervalHours: 24,
      maxPerDay: 3,
      dedupWindowDays: 30,
      temporalEchoThreshold: 0.75,
      staleTodoDays: 7,
    },
    timezone: "Europe/Madrid",
  },
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);
vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}));
vi.mock("../../src/telegram/notify.js", () => ({
  notifyError: vi.fn(),
}));
vi.mock("../../src/utils/dates.js", () => ({
  todayInTimezone: () => "2026-03-08",
}));

import { runInsightEngine, startInsightTimer } from "../../src/insights/engine.js";
import { notifyError } from "../../src/telegram/notify.js";

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
  mockSendTelegramMessage.mockClear().mockResolvedValue(undefined);
  mockQueries.countInsightsNotifiedToday.mockResolvedValue(0);
  mockQueries.findTemporalEchoes.mockResolvedValue([]);
  mockQueries.getOuraSummaryByDay.mockResolvedValue(null);
  mockQueries.getEntriesByDateRange.mockResolvedValue([]);
  mockQueries.findStaleTodos.mockResolvedValue([]);
  mockQueries.insightHashExists.mockResolvedValue(false);
  mockQueries.insertInsight.mockResolvedValue(1);
  mockConfig.config.telegram.botToken = "test-bot-token";
  mockConfig.config.telegram.allowedChatId = "100";
});

describe("runInsightEngine", () => {
  it("returns null when advisory lock is not acquired", async () => {
    const pool = makeMockPool(false);
    const result = await runInsightEngine(pool);
    expect(result).toBeNull();
  });

  it("releases advisory lock even when no candidates", async () => {
    const pool = makeMockPool(true);
    await runInsightEngine(pool);
    const unlockCalls = pool.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("pg_advisory_unlock")
    );
    expect(unlockCalls).toHaveLength(1);
  });

  it("returns zero counts when no candidates found", async () => {
    const pool = makeMockPool(true);
    const result = await runInsightEngine(pool);
    expect(result).toEqual({
      candidatesGenerated: 0,
      insightsNotified: 0,
      skippedDedup: 0,
      skippedCap: 0,
    });
  });

  it("returns zero counts when daily cap is already reached", async () => {
    mockQueries.countInsightsNotifiedToday.mockResolvedValue(3);
    const pool = makeMockPool(true);
    const result = await runInsightEngine(pool);
    expect(result).toEqual({
      candidatesGenerated: 0,
      insightsNotified: 0,
      skippedDedup: 0,
      skippedCap: 0,
    });
  });

  it("processes stale todos and sends notification", async () => {
    mockQueries.findStaleTodos.mockResolvedValue([
      { id: "t1", title: "Fix taxes", days_stale: 14, important: true, urgent: false, next_step: "Call accountant" },
    ]);

    const pool = makeMockPool(true);
    const result = await runInsightEngine(pool);

    expect(result!.candidatesGenerated).toBe(1);
    expect(result!.insightsNotified).toBe(1);
    expect(mockQueries.insertInsight).toHaveBeenCalledOnce();
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
    expect(mockQueries.markInsightNotified).toHaveBeenCalledOnce();
  });

  it("skips duplicate insights", async () => {
    mockQueries.findStaleTodos.mockResolvedValue([
      { id: "t1", title: "Fix taxes", days_stale: 14, important: true, urgent: false, next_step: null },
    ]);
    mockQueries.insightHashExists.mockResolvedValue(true);

    const pool = makeMockPool(true);
    const result = await runInsightEngine(pool);

    expect(result!.candidatesGenerated).toBe(1);
    expect(result!.skippedDedup).toBe(1);
    expect(result!.insightsNotified).toBe(0);
    expect(mockQueries.insertInsight).not.toHaveBeenCalled();
  });

  it("respects daily cap", async () => {
    mockQueries.countInsightsNotifiedToday.mockResolvedValue(2); // 1 remaining
    mockQueries.findStaleTodos.mockResolvedValue([
      { id: "t1", title: "One", days_stale: 14, important: true, urgent: false, next_step: null },
      { id: "t2", title: "Two", days_stale: 10, important: false, urgent: false, next_step: null },
    ]);

    const pool = makeMockPool(true);
    const result = await runInsightEngine(pool);

    expect(result!.insightsNotified).toBe(1);
    expect(result!.skippedCap).toBe(1);
  });

  it("processes temporal echoes", async () => {
    mockQueries.findTemporalEchoes.mockResolvedValue([
      {
        current_uuid: "uuid-today",
        echo_uuid: "uuid-2023",
        echo_year: 2023,
        similarity: 0.85,
        echo_preview: "Old entry...",
        current_preview: "New entry...",
      },
    ]);

    const pool = makeMockPool(true);
    const result = await runInsightEngine(pool);

    expect(result!.candidatesGenerated).toBe(1);
    expect(result!.insightsNotified).toBe(1);
  });

  it("processes biometric correlations with outlier", async () => {
    mockQueries.getOuraSummaryByDay.mockResolvedValue({
      day: new Date(),
      sleep_score: 50,
      readiness_score: 80,
      activity_score: 70,
      steps: 5000,
      stress: null,
      average_hrv: 40,
      average_heart_rate: 60,
      sleep_duration_seconds: 28800,
      deep_sleep_duration_seconds: null,
      rem_sleep_duration_seconds: null,
      efficiency: null,
      workout_count: 0,
    });
    mockQueries.getEntriesByDateRange.mockResolvedValue([
      { uuid: "e1", text: "Bad day at work...", created_at: new Date() },
    ]);

    const pool = makeMockPool(true);
    const result = await runInsightEngine(pool);

    expect(result!.candidatesGenerated).toBe(1);
    expect(result!.insightsNotified).toBe(1);
  });

  it("releases lock even on error", async () => {
    mockQueries.countInsightsNotifiedToday.mockRejectedValue(new Error("DB error"));

    const pool = makeMockPool(true);
    await expect(runInsightEngine(pool)).rejects.toThrow("DB error");

    const unlockCalls = pool.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("pg_advisory_unlock")
    );
    expect(unlockCalls).toHaveLength(1);
  });
});

describe("startInsightTimer", () => {
  it("returns null when no bot token", () => {
    mockConfig.config.telegram.botToken = "";
    const pool = makeMockPool();
    expect(startInsightTimer(pool)).toBeNull();
  });

  it("returns null when no allowed chat id", () => {
    mockConfig.config.telegram.allowedChatId = "";
    const pool = makeMockPool();
    expect(startInsightTimer(pool)).toBeNull();
  });

  it("returns timer when configured", () => {
    const pool = makeMockPool();
    const timer = startInsightTimer(pool);
    expect(timer).not.toBeNull();
    clearInterval(timer!);
  });
});
