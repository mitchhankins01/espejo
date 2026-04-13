import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EntryRow } from "../../src/db/queries.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockQueries = vi.hoisted(() => ({
  getEntriesOnThisDay: vi.fn(),
  insertActivityLog: vi.fn().mockResolvedValue({ id: 1 }),
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    onThisDay: { enabled: true, targetHour: 8 },
    telegram: { botToken: "tok", allowedChatId: "123" },
    anthropic: { apiKey: "key", model: "claude-sonnet-4-6" },
    timezone: "Europe/Madrid",
  },
}));

const mockTelegram = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn(),
}));

const mockNotify = vi.hoisted(() => ({
  notifyError: vi.fn(),
}));

const mockDates = vi.hoisted(() => ({
  todayInTimezone: vi.fn().mockReturnValue("2026-04-10"),
  currentHourInTimezone: vi.fn().mockReturnValue(8),
}));

const mockAnthropicCreate = vi.fn().mockResolvedValue({
  content: [{ type: "text", text: "A beautiful reflection about your past." }],
  usage: { input_tokens: 500, output_tokens: 100 },
});

const mockConstants = vi.hoisted(() => ({
  getAnthropic: vi.fn(() => ({ messages: { create: mockAnthropicCreate } })),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);
vi.mock("../../src/telegram/client.js", () => mockTelegram);
vi.mock("../../src/telegram/notify.js", () => mockNotify);
vi.mock("../../src/utils/dates.js", () => mockDates);
vi.mock("../../src/telegram/agent/constants.js", () => mockConstants);

import {
  formatEntriesForPrompt,
  synthesizeReflection,
  runOnThisDay,
  startOnThisDayTimer,
} from "../../src/notifications/on-this-day.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    uuid: "TEST-UUID",
    text: "Went for a long walk in the park today. Feeling grateful.",
    created_at: new Date("2023-04-10T09:30:00Z"),
    modified_at: null,
    timezone: null,
    city: "Barcelona",
    country: "Spain",
    place_name: null,
    admin_area: null,
    latitude: null,
    longitude: null,
    temperature: null,
    weather_conditions: null,
    humidity: null,
    source: "dayone",
    version: 1,
    photo_count: 0,
    video_count: 0,
    audio_count: 0,
    media: [],
    weight_kg: null,
    ...overrides,
  };
}

const mockPool = {
  query: vi.fn(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockDates.todayInTimezone.mockReturnValue("2026-04-10");
  mockDates.currentHourInTimezone.mockReturnValue(8);
  mockConfig.config.onThisDay.enabled = true;
  mockConfig.config.telegram.allowedChatId = "123";
  // Default: no previous send today
  mockPool.query.mockImplementation((sql: string) => {
    if (sql.includes("activity_logs")) return { rows: [{ count: "0" }] };
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok: true }] };
    if (sql.includes("pg_advisory_unlock")) return { rows: [] };
    return { rows: [] };
  });
});

// ---------------------------------------------------------------------------
// formatEntriesForPrompt
// ---------------------------------------------------------------------------

describe("formatEntriesForPrompt", () => {
  it("formats a single entry with year-ago framing", () => {
    const today = new Date("2026-04-10");
    const result = formatEntriesForPrompt([makeEntry()], today);

    expect(result).toContain("3 years ago");
    expect(result).toContain("April 10, 2023");
    expect(result).toContain("Barcelona, Spain");
    expect(result).toContain("Went for a long walk");
  });

  it("includes media counts when present", () => {
    const today = new Date("2026-04-10");
    const entry = makeEntry({ photo_count: 3, video_count: 1 });
    const result = formatEntriesForPrompt([entry], today);

    expect(result).toContain("3 photos");
    expect(result).toContain("1 video");
  });

  it("truncates long entries", () => {
    const today = new Date("2026-04-10");
    const longText = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const entry = makeEntry({ text: longText });
    const result = formatEntriesForPrompt([entry], today);

    // Should be truncated at 1500 words with ellipsis
    const words = result.split(/\s+/);
    expect(words.length).toBeLessThan(2000);
    expect(result).toContain("…");
  });

  it("caps at 20 entries", () => {
    const today = new Date("2026-04-10");
    const entries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({
        id: i,
        created_at: new Date(`${2001 + i}-04-10T09:00:00Z`),
        text: `Entry ${i}`,
      })
    );
    const result = formatEntriesForPrompt(entries, today);

    // Count the separator pattern
    const separators = result.match(/---.*years? ago/g);
    expect(separators).toHaveLength(20);
  });

  it("handles singular year", () => {
    const today = new Date("2026-04-10");
    const entry = makeEntry({ created_at: new Date("2025-04-10T09:00:00Z") });
    const result = formatEntriesForPrompt([entry], today);

    expect(result).toContain("1 year ago");
    expect(result).not.toContain("1 years ago");
  });
});

// ---------------------------------------------------------------------------
// synthesizeReflection
// ---------------------------------------------------------------------------

describe("synthesizeReflection", () => {
  it("calls Anthropic with system prompt and entry data", async () => {
    const entries = [makeEntry()];
    const result = await synthesizeReflection(entries);

    expect(mockAnthropicCreate).toHaveBeenCalledOnce();
    const callArgs = mockAnthropicCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("On This Day");
    expect(callArgs.messages[0].content).toContain("Barcelona");
    expect(result.text).toBe("A beautiful reflection about your past.");
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// runOnThisDay
// ---------------------------------------------------------------------------

describe("runOnThisDay", () => {
  it("sends reflection when entries exist and conditions met", async () => {
    mockQueries.getEntriesOnThisDay.mockResolvedValue([makeEntry()]);

    await runOnThisDay(mockPool);

    expect(mockTelegram.sendTelegramMessage).toHaveBeenCalledOnce();
    const [chatId, text] = mockTelegram.sendTelegramMessage.mock.calls[0];
    expect(chatId).toBe("123");
    expect(text).toContain("On This Day");
    expect(text).toContain("A beautiful reflection");
  });

  it("logs API usage after successful send", async () => {
    mockQueries.getEntriesOnThisDay.mockResolvedValue([makeEntry()]);

    await runOnThisDay(mockPool);

    expect(mockQueries.insertActivityLog).toHaveBeenCalledOnce();
  });

  it("skips when not target hour", async () => {
    mockDates.currentHourInTimezone.mockReturnValue(10);

    await runOnThisDay(mockPool);

    expect(mockQueries.getEntriesOnThisDay).not.toHaveBeenCalled();
    expect(mockTelegram.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips when already sent today", async () => {
    mockPool.query.mockImplementation((sql: string) => {
      if (sql.includes("activity_logs")) return { rows: [{ count: "1" }] };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok: true }] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      return { rows: [] };
    });

    await runOnThisDay(mockPool);

    expect(mockQueries.getEntriesOnThisDay).not.toHaveBeenCalled();
  });

  it("skips silently when no entries for today", async () => {
    mockQueries.getEntriesOnThisDay.mockResolvedValue([]);

    await runOnThisDay(mockPool);

    expect(mockTelegram.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips when feature is disabled", async () => {
    mockConfig.config.onThisDay.enabled = false;

    await runOnThisDay(mockPool);

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("skips when no allowed chat ID", async () => {
    mockConfig.config.telegram.allowedChatId = "";

    await runOnThisDay(mockPool);

    expect(mockQueries.getEntriesOnThisDay).not.toHaveBeenCalled();
  });

  it("skips when advisory lock not acquired", async () => {
    mockPool.query.mockImplementation((sql: string) => {
      if (sql.includes("activity_logs")) return { rows: [{ count: "0" }] };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok: false }] };
      return { rows: [] };
    });

    await runOnThisDay(mockPool);

    expect(mockQueries.getEntriesOnThisDay).not.toHaveBeenCalled();
  });

  it("releases advisory lock even on error", async () => {
    mockQueries.getEntriesOnThisDay.mockRejectedValue(new Error("DB error"));

    await expect(runOnThisDay(mockPool)).rejects.toThrow("DB error");

    const unlockCalls = mockPool.query.mock.calls.filter(
      ([sql]: [string]) => sql.includes("pg_advisory_unlock")
    );
    expect(unlockCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// startOnThisDayTimer
// ---------------------------------------------------------------------------

describe("startOnThisDayTimer", () => {
  it("returns null when feature is disabled", () => {
    mockConfig.config.onThisDay.enabled = false;

    const result = startOnThisDayTimer(mockPool);

    expect(result).toBeNull();
  });

  it("returns a timeout handle when enabled", () => {
    const handle = startOnThisDayTimer(mockPool);

    expect(handle).not.toBeNull();
    clearInterval(handle!);
  });
});
