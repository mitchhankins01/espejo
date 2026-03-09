import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  countInsightsNotifiedToday: vi.fn().mockResolvedValue(0),
  getOuraTrendMetric: vi.fn().mockResolvedValue([]),
  getOuraSummaryByDay: vi.fn().mockResolvedValue(null),
  insightHashExists: vi.fn().mockResolvedValue(false),
  insertInsight: vi.fn().mockResolvedValue(1),
  markInsightNotified: vi.fn().mockResolvedValue(undefined),
}));

const mockSendTelegram = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockConfig = vi.hoisted(() => ({
  config: {
    timezone: "Europe/Madrid",
    insights: { maxPerDay: 3, dedupWindowDays: 30 },
    telegram: { botToken: "test-token", allowedChatId: "100" },
  },
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);
vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: mockSendTelegram,
}));

import { runOuraNotableCheck } from "../../src/insights/oura-notable.js";

function makeMockPool(lockResult = true): any {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ ok: lockResult }] });
      }
      if (sql.includes("pg_advisory_unlock")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("oura_daily_sleep")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const fn of Object.values(mockQueries)) {
    if (typeof fn.mockClear === "function") fn.mockClear();
  }
  mockQueries.countInsightsNotifiedToday.mockResolvedValue(0);
  mockQueries.getOuraTrendMetric.mockResolvedValue([]);
  mockQueries.getOuraSummaryByDay.mockResolvedValue(null);
  mockQueries.insightHashExists.mockResolvedValue(false);
  mockQueries.insertInsight.mockResolvedValue(1);
  mockSendTelegram.mockReset().mockResolvedValue(undefined);
});

describe("runOuraNotableCheck", () => {
  it("returns null when advisory lock not acquired", async () => {
    const pool = makeMockPool(false);
    const result = await runOuraNotableCheck(pool);
    expect(result).toBeNull();
  });

  it("returns zero counts when daily cap reached", async () => {
    mockQueries.countInsightsNotifiedToday.mockResolvedValue(3);
    const pool = makeMockPool();
    const result = await runOuraNotableCheck(pool);
    expect(result).toEqual({
      candidatesGenerated: 0,
      insightsNotified: 0,
      skippedDedup: 0,
      skippedCap: 0,
    });
  });

  it("fetches metrics and processes candidates", async () => {
    // Provide outlier data for sleep_score
    const trendData = Array.from({ length: 15 }, (_, i) => ({
      day: new Date(`2026-03-${String(i + 1).padStart(2, "0")}`),
      value: i === 14 ? 42 : 78 + (i % 3),
    }));
    mockQueries.getOuraTrendMetric.mockResolvedValue(trendData);

    const pool = makeMockPool();
    const result = await runOuraNotableCheck(pool);

    expect(result).not.toBeNull();
    expect(result!.candidatesGenerated).toBeGreaterThan(0);
    expect(mockQueries.getOuraTrendMetric).toHaveBeenCalledTimes(5); // 5 metrics
    expect(mockQueries.insertInsight).toHaveBeenCalled();
    expect(mockQueries.markInsightNotified).toHaveBeenCalled();
  });

  it("skips duplicate insights", async () => {
    const trendData = Array.from({ length: 15 }, (_, i) => ({
      day: new Date(`2026-03-${String(i + 1).padStart(2, "0")}`),
      value: i === 14 ? 42 : 78 + (i % 3),
    }));
    mockQueries.getOuraTrendMetric.mockResolvedValue(trendData);
    mockQueries.insightHashExists.mockResolvedValue(true);

    const pool = makeMockPool();
    const result = await runOuraNotableCheck(pool);

    expect(result!.skippedDedup).toBeGreaterThan(0);
    expect(result!.insightsNotified).toBe(0);
    expect(mockQueries.insertInsight).not.toHaveBeenCalled();
  });

  it("releases advisory lock on completion", async () => {
    const pool = makeMockPool();
    await runOuraNotableCheck(pool);

    expect(pool.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      [9152202]
    );
  });

  it("releases advisory lock on error", async () => {
    mockQueries.countInsightsNotifiedToday.mockRejectedValue(new Error("DB error"));
    const pool = makeMockPool();

    await expect(runOuraNotableCheck(pool)).rejects.toThrow("DB error");
    expect(pool.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1)",
      [9152202]
    );
  });

  it("sends telegram notification for notable insights", async () => {
    const trendData = Array.from({ length: 15 }, (_, i) => ({
      day: new Date(`2026-03-${String(i + 1).padStart(2, "0")}`),
      value: i === 14 ? 42 : 78 + (i % 3),
    }));
    mockQueries.getOuraTrendMetric.mockResolvedValue(trendData);

    const pool = makeMockPool();
    await runOuraNotableCheck(pool);

    expect(mockSendTelegram).toHaveBeenCalled();
    expect(mockSendTelegram).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Sleep score")
    );
  });
});
