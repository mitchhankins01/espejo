import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: { botToken: "test-token", allowedChatId: "123", secretToken: "s" },
    checkins: { enabled: true, intervalMinutes: 15, ignoreThreshold: 3 },
  },
}));

const mockQueries = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  upsertUserSettings: vi.fn(),
  insertCheckin: vi.fn(),
  getLastCheckinForWindow: vi.fn(),
  markCheckinsIgnored: vi.fn(),
  getConsecutiveIgnoredCount: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);

vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/telegram/notify.js", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../../src/utils/dates.js", () => ({
  currentHourInTimezone: vi.fn(() => 9),
  todayDateInTimezone: vi.fn(() => "2026-03-08"),
  currentTimeLabel: vi.fn(() => "Morning (9:00)"),
}));

vi.mock("../../src/oura/context.js", () => ({
  buildOuraContextPrompt: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/todos/context.js", () => ({
  buildTodoContextPrompt: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/checkins/prompts.js", () => ({
  buildCheckinPrompt: vi.fn(() => "Buenos días. ¿Cómo estás?"),
}));

import {
  isWindowDue,
  runCheckinEngine,
  pendingCheckins,
  startCheckinTimer,
} from "../../src/checkins/scheduler.js";

const mockPool = {
  query: vi.fn(),
} as any;

const defaultSettings = {
  chat_id: "123",
  timezone: "Europe/Madrid",
  checkin_enabled: true,
  checkin_morning_hour: 9,
  checkin_afternoon_hour: 14,
  checkin_evening_hour: 21,
  checkin_snooze_until: null,
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  pendingCheckins.clear();
  mockPool.query.mockResolvedValue({ rows: [{ ok: true }] });
  mockQueries.getUserSettings.mockResolvedValue(defaultSettings);
  mockQueries.getLastCheckinForWindow.mockResolvedValue(null);
  mockQueries.getConsecutiveIgnoredCount.mockResolvedValue(0);
  mockQueries.insertCheckin.mockResolvedValue(1);
  mockQueries.markCheckinsIgnored.mockResolvedValue(0);
});

describe("isWindowDue", () => {
  it("returns true when hours match", () => {
    expect(isWindowDue(9, 9)).toBe(true);
  });

  it("returns false when hours differ", () => {
    expect(isWindowDue(10, 9)).toBe(false);
  });
});

describe("runCheckinEngine", () => {
  it("returns null when advisory lock not acquired", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ ok: false }] });
    const result = await runCheckinEngine(mockPool);
    expect(result).toBeNull();
  });

  it("skips when checkins are disabled", async () => {
    mockQueries.getUserSettings.mockResolvedValue({ ...defaultSettings, checkin_enabled: false });
    const result = await runCheckinEngine(mockPool);
    expect(result!.skippedDisabled).toBe(true);
    expect(result!.checkinsSent).toBe(0);
  });

  it("skips when snoozed", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    mockQueries.getUserSettings.mockResolvedValue({ ...defaultSettings, checkin_snooze_until: future });
    const result = await runCheckinEngine(mockPool);
    expect(result!.skippedSnoozed).toBe(true);
    expect(result!.checkinsSent).toBe(0);
  });

  it("sends a check-in when window is due", async () => {
    const result = await runCheckinEngine(mockPool);
    expect(result!.checkinsSent).toBe(1);
    expect(mockQueries.insertCheckin).toHaveBeenCalled();
    expect(pendingCheckins.has("123")).toBe(true);
  });

  it("skips already sent window", async () => {
    mockQueries.getLastCheckinForWindow.mockResolvedValue({
      id: 1,
      created_at: new Date(),
    });
    const result = await runCheckinEngine(mockPool);
    expect(result!.checkinsSent).toBe(0);
  });

  it("sends adaptation prompt after consecutive ignores", async () => {
    mockQueries.getConsecutiveIgnoredCount.mockResolvedValue(3);
    const result = await runCheckinEngine(mockPool);
    expect(result!.checkinsSent).toBe(1);
    expect(mockQueries.insertCheckin).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        metadata: expect.objectContaining({ adaptation: true }),
      })
    );
  });

  it("creates settings when none exist", async () => {
    mockQueries.getUserSettings.mockResolvedValue(null);
    mockQueries.upsertUserSettings.mockResolvedValue(defaultSettings);
    const result = await runCheckinEngine(mockPool);
    expect(mockQueries.upsertUserSettings).toHaveBeenCalledWith(mockPool, "123", {});
    expect(result!.checkinsSent).toBe(1);
  });

  it("sweeps ignored check-ins", async () => {
    mockQueries.markCheckinsIgnored.mockResolvedValue(2);
    const result = await runCheckinEngine(mockPool);
    expect(result!.checkinsIgnored).toBe(2);
  });

  it("releases advisory lock on completion", async () => {
    await runCheckinEngine(mockPool);
    const unlockCall = mockPool.query.mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("pg_advisory_unlock")
    );
    expect(unlockCall).toBeDefined();
  });
});

describe("startCheckinTimer", () => {
  it("returns null when disabled", async () => {
    const { config } = await import("../../src/config.js");
    (config.checkins as any).enabled = false;
    const result = startCheckinTimer(mockPool);
    expect(result).toBeNull();
    (config.checkins as any).enabled = true;
  });
});
