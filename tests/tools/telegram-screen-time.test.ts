import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTelegramFile: vi.fn(),
  upsertDailyScreenTime: vi.fn(),
  logUsage: vi.fn(),
  todayInTimezone: vi.fn(() => "2026-05-03"),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: { botToken: "123:ABC" },
    openai: { apiKey: "sk-test" },
    timezone: "Europe/Madrid",
    models: { openaiVision: "gpt-4.1" },
  },
}));

vi.mock("../../src/utils/dates.js", () => ({
  todayInTimezone: mocks.todayInTimezone,
}));

vi.mock("../../src/telegram/media.js", () => ({
  fetchTelegramFile: mocks.fetchTelegramFile,
}));

vi.mock("../../src/db/queries/daily-screen-time.js", () => ({
  upsertDailyScreenTime: mocks.upsertDailyScreenTime,
}));

vi.mock("../../src/db/queries/usage.js", () => ({
  logUsage: mocks.logUsage,
}));

import {
  extractScreenTimeJson,
  processScreenTimePhotos,
} from "../../src/telegram/screen-time.js";

const mockPool = {} as unknown as import("pg").Pool;

type DailyRow =
  import("../../src/db/queries/daily-screen-time.js").DailyScreenTimeRow;

function makeRow(overrides: Partial<DailyRow> = {}): DailyRow {
  return {
    date: "2026-05-02",
    total_minutes: 0,
    categories: [],
    apps: [],
    pickups: null,
    first_pickup: null,
    pickup_apps: null,
    notifications: null,
    notification_apps: null,
    source_message_id: null,
    raw_text: null,
    ingested_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.fetchTelegramFile.mockReset();
  mocks.upsertDailyScreenTime.mockReset();
  mocks.logUsage.mockReset();
  mocks.todayInTimezone.mockReset().mockReturnValue("2026-05-03");
});

describe("extractScreenTimeJson", () => {
  function buildResponse(payload: unknown): {
    choices: { message: { content: string } }[];
  } {
    return {
      choices: [{ message: { content: JSON.stringify(payload) } }],
    };
  }

  it("parses valid screen-time JSON", async () => {
    const create = vi.fn().mockResolvedValue(
      buildResponse({
        is_screen_time: true,
        date: "2026-05-02",
        total_minutes: 240,
        categories: [{ name: "Social", minutes: 60 }],
        apps: [{ app: "Telegram", minutes: 50 }],
        pickups: 78,
        first_pickup: "07:42",
        pickup_apps: [{ app: "Telegram", count: 10 }],
        notifications: 120,
        notification_apps: [{ app: "Mail", count: 30 }],
      })
    );
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    const { json, raw } = await extractScreenTimeJson(
      [Buffer.from("a"), Buffer.from("b")],
      fakeClient,
      "2026-05-03"
    );

    expect(json.is_screen_time).toBe(true);
    expect(json.date).toBe("2026-05-02");
    expect(json.total_minutes).toBe(240);
    expect(raw).toContain("total_minutes");
    expect(create).toHaveBeenCalledTimes(1);
    const callArg = create.mock.calls[0][0];
    expect(callArg.response_format).toEqual({ type: "json_object" });
    // 1 text prompt + 2 images
    const userContent = callArg.messages[1].content as unknown[];
    expect(userContent).toHaveLength(3);
    // Today's date is woven into the prompt so the model can resolve "Ayer"
    expect((userContent[0] as { text: string }).text).toContain("2026-05-03");
  });

  it("coerces null per-entry minutes/count to 0 instead of rejecting the payload", async () => {
    // iOS lists some apps with an unreadable/sub-minute duration, so the vision
    // model occasionally emits `minutes: null` for one row. A single bad entry
    // must not sink the whole screenshot (regression: app-breakdown dropped).
    const create = vi.fn().mockResolvedValue(
      buildResponse({
        is_screen_time: true,
        date: "2026-05-02",
        total_minutes: 312,
        categories: [{ name: "Social", minutes: null }],
        apps: [
          { app: "WhatsApp", minutes: 169 },
          { app: "Settings", minutes: null },
        ],
        pickups: 47,
        first_pickup: "07:30",
        pickup_apps: [{ app: "Telegram", count: null }],
        notifications: 88,
        notification_apps: [{ app: "Mail", count: 20 }],
      })
    );
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    const { json } = await extractScreenTimeJson(
      [Buffer.from("a")],
      fakeClient,
      "2026-05-03"
    );

    expect(json.apps).toEqual([
      { app: "WhatsApp", minutes: 169 },
      { app: "Settings", minutes: 0 },
    ]);
    expect(json.categories).toEqual([{ name: "Social", minutes: 0 }]);
    expect(json.pickup_apps).toEqual([{ app: "Telegram", count: 0 }]);
  });

  it("parses a non-screen-time response with nulls", async () => {
    const create = vi.fn().mockResolvedValue(
      buildResponse({
        is_screen_time: false,
        date: null,
        total_minutes: null,
        categories: null,
        apps: null,
        pickups: null,
        first_pickup: null,
        pickup_apps: null,
        notifications: null,
        notification_apps: null,
      })
    );
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    const { json } = await extractScreenTimeJson(
      [Buffer.from("a")],
      fakeClient,
      "2026-05-03"
    );

    expect(json.is_screen_time).toBe(false);
    expect(json.date).toBeNull();
    expect(json.total_minutes).toBeNull();
  });

  it("throws on empty response", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient, "2026-05-03")
    ).rejects.toThrow("empty response");
  });

  it("throws on non-JSON response", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    });
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient, "2026-05-03")
    ).rejects.toThrow("non-JSON");
  });

  it("throws on JSON that fails schema validation", async () => {
    const create = vi.fn().mockResolvedValue(
      buildResponse({
        is_screen_time: "yes", // wrong type
        date: null,
      })
    );
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient, "2026-05-03")
    ).rejects.toThrow();
  });

  it("handles missing message content gracefully", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: {} }],
    });
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient, "2026-05-03")
    ).rejects.toThrow("empty response");
  });
});

describe("processScreenTimePhotos", () => {
  function makeFakeClient(json: unknown): import("openai").default {
    return {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: JSON.stringify(json) } }],
          }),
        },
      },
    } as unknown as import("openai").default;
  }

  it("rejects when photos array is empty", async () => {
    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [],
    });
    expect(result.ok).toBe(false);
    expect(result.isScreenTime).toBe(false);
    expect(result.error).toBe("no_photos");
    expect(mocks.upsertDailyScreenTime).not.toHaveBeenCalled();
  });

  it("returns isScreenTime=false and skips upsert when the model says it's not Screen Time", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const fakeClient = makeFakeClient({
      is_screen_time: false,
      date: null,
      total_minutes: null,
      categories: null,
      apps: null,
      pickups: null,
      first_pickup: null,
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(result).toEqual({ ok: true, isScreenTime: false });
    expect(mocks.upsertDailyScreenTime).not.toHaveBeenCalled();
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        action: "detect",
        ok: true,
        meta: expect.objectContaining({ is_screen_time: false }),
      })
    );
  });

  it("falls through (isScreenTime=false) when vision call throws", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const fakeClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("vision exploded")),
        },
      },
    } as unknown as import("openai").default;

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(result.ok).toBe(false);
    expect(result.isScreenTime).toBe(false);
    expect(result.error).toContain("vision exploded");
    expect(mocks.upsertDailyScreenTime).not.toHaveBeenCalled();
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ action: "detect", ok: false })
    );
  });

  it("notifies + returns missing_date when detected but date is null", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: null,
      total_minutes: 60,
      categories: [],
      apps: [],
      pickups: null,
      first_pickup: null,
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
      notify,
    });

    expect(result).toEqual({
      ok: false,
      isScreenTime: true,
      error: "missing_date",
    });
    expect(mocks.upsertDailyScreenTime).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("couldn't read the date")
    );
  });

  it("ingests successfully and notifies based on the merged row", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    // Simulate merged row: prior data was richer than this single payload.
    mocks.upsertDailyScreenTime.mockResolvedValue(
      makeRow({
        total_minutes: 275,
        apps: [
          { app: "Telegram", minutes: 50 },
          { app: "Safari", minutes: 30 },
        ],
        pickups: 127,
        notifications: 360,
      })
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: "2026-05-02",
      total_minutes: 125,
      categories: [{ name: "Social", minutes: 50 }],
      apps: [{ app: "Telegram", minutes: 50 }],
      pickups: 40,
      first_pickup: "07:30",
      pickup_apps: [{ app: "Telegram", count: 10 }],
      notifications: 80,
      notification_apps: [{ app: "Mail", count: 20 }],
    });

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 42,
      photos: [
        { fileId: "p1", caption: "" },
        { fileId: "p2", caption: "" },
      ],
      openai: fakeClient,
      notify,
    });

    expect(result).toEqual({ ok: true, isScreenTime: true, date: "2026-05-02" });
    expect(mocks.fetchTelegramFile).toHaveBeenCalledTimes(2);
    expect(mocks.upsertDailyScreenTime).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        date: "2026-05-02",
        totalMinutes: 125,
        firstPickup: "07:30:00",
        sourceMessageId: 42,
      })
    );
    // Notify reflects the merged row (4h 35m total, 2 apps, 127 pickups,
    // 360 notifs), not the single-photo payload (2h 5m, 1 app, 40 / 80).
    expect(notify).toHaveBeenCalledWith(
      "100",
      "📱 Screen Time saved for 2026-05-02: 4h 35m total, 2 apps, 127 pickups, 360 notifs."
    );
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ ok: true, action: "ingest" })
    );
  });

  it("uses configured today when no override is provided", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockResolvedValue(makeRow());
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              is_screen_time: true,
              date: "2026-05-02",
              total_minutes: 30,
              categories: [],
              apps: [],
              pickups: null,
              first_pickup: null,
              pickup_apps: null,
              notifications: null,
              notification_apps: null,
            }),
          },
        },
      ],
    });
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(mocks.todayInTimezone).toHaveBeenCalled();
    const callArg = create.mock.calls[0][0];
    const userText = (callArg.messages[1].content as { text: string }[])[0]
      .text;
    expect(userText).toContain("2026-05-03"); // mocked todayInTimezone return
  });

  it("handles HH:MM:SS first_pickup without re-padding", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockResolvedValue(makeRow());

    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: "2026-05-02",
      total_minutes: 60,
      categories: [],
      apps: [],
      pickups: null,
      first_pickup: "07:30:15",
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(mocks.upsertDailyScreenTime).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ firstPickup: "07:30:15" })
    );
  });

  it("formats notify message with hours when total exceeds 60 min", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockResolvedValue(
      makeRow({ total_minutes: 125 })
    );
    const notify = vi.fn().mockResolvedValue(undefined);

    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: "2026-05-02",
      total_minutes: 125,
      categories: [],
      apps: [],
      pickups: null,
      first_pickup: null,
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("2h 5m total")
    );
  });

  it("formats notify message with only minutes when under 60", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockResolvedValue(
      makeRow({ total_minutes: 45 })
    );
    const notify = vi.fn().mockResolvedValue(undefined);

    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: "2026-05-02",
      total_minutes: 45,
      categories: [],
      apps: [],
      pickups: null,
      first_pickup: null,
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("45m total")
    );
  });

  it("logs failure and notifies on DB upsert error", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockRejectedValue(new Error("db down"));
    const notify = vi.fn().mockResolvedValue(undefined);

    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: "2026-05-02",
      total_minutes: 60,
      categories: [],
      apps: [],
      pickups: null,
      first_pickup: null,
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
      notify,
    });

    expect(result.ok).toBe(false);
    expect(result.isScreenTime).toBe(true);
    expect(result.error).toContain("db down");
    expect(notify).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Screen Time ingest failed")
    );
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ ok: false, action: "ingest" })
    );
  });

  it("logs failure even when notify is not provided", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockRejectedValue(new Error("boom"));

    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: "2026-05-02",
      total_minutes: 60,
      categories: [],
      apps: [],
      pickups: null,
      first_pickup: null,
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(result.ok).toBe(false);
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ ok: false })
    );
  });

  it("succeeds without notify callback", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockResolvedValue(makeRow());

    const fakeClient = makeFakeClient({
      is_screen_time: true,
      date: "2026-05-02",
      total_minutes: 30,
      categories: [],
      apps: [],
      pickups: null,
      first_pickup: null,
      pickup_apps: null,
      notifications: null,
      notification_apps: null,
    });

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(result.ok).toBe(true);
    expect(result.isScreenTime).toBe(true);
  });
});
