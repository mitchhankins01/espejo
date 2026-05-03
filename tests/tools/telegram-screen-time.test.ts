import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTelegramFile: vi.fn(),
  upsertDailyScreenTime: vi.fn(),
  logUsage: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: { botToken: "123:ABC" },
    openai: { apiKey: "sk-test" },
  },
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
  parseScreenTimeCaption,
  extractScreenTimeJson,
  processScreenTimePhotos,
} from "../../src/telegram/screen-time.js";

const mockPool = {} as unknown as import("pg").Pool;

beforeEach(() => {
  mocks.fetchTelegramFile.mockReset();
  mocks.upsertDailyScreenTime.mockReset();
  mocks.logUsage.mockReset();
});

describe("parseScreenTimeCaption", () => {
  it("parses a well-formed caption", () => {
    expect(parseScreenTimeCaption("screen_time 2026-05-03")).toBe("2026-05-03");
  });

  it("is case-insensitive on the prefix", () => {
    expect(parseScreenTimeCaption("Screen_Time 2026-05-03")).toBe("2026-05-03");
  });

  it("trims surrounding whitespace", () => {
    expect(parseScreenTimeCaption("  screen_time 2026-05-03  ")).toBe(
      "2026-05-03"
    );
  });

  it("returns null for missing date", () => {
    expect(parseScreenTimeCaption("screen_time")).toBeNull();
  });

  it("returns null for invalid date format", () => {
    expect(parseScreenTimeCaption("screen_time 2026/05/03")).toBeNull();
    expect(parseScreenTimeCaption("screen_time 26-05-03")).toBeNull();
  });

  it("returns null for unrelated captions", () => {
    expect(parseScreenTimeCaption("hello world")).toBeNull();
    expect(parseScreenTimeCaption("")).toBeNull();
    expect(parseScreenTimeCaption(null)).toBeNull();
    expect(parseScreenTimeCaption(undefined)).toBeNull();
  });

  it("rejects impossible dates that pass regex", () => {
    expect(parseScreenTimeCaption("screen_time 2026-02-31")).toBeNull();
    expect(parseScreenTimeCaption("screen_time 2026-13-01")).toBeNull();
  });
});

describe("extractScreenTimeJson", () => {
  it("parses valid JSON from the vision model", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              total_minutes: 240,
              categories: [{ name: "Social", minutes: 60 }],
              apps: [{ app: "Telegram", minutes: 50 }],
              pickups: 78,
              first_pickup: "07:42",
              pickup_apps: [{ app: "Telegram", count: 10 }],
              notifications: 120,
              notification_apps: [{ app: "Mail", count: 30 }],
            }),
          },
        },
      ],
    });
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as import("openai").default;

    const { json, raw } = await extractScreenTimeJson(
      [Buffer.from("a"), Buffer.from("b")],
      fakeClient
    );

    expect(json.total_minutes).toBe(240);
    expect(json.categories).toHaveLength(1);
    expect(raw).toContain("total_minutes");
    expect(create).toHaveBeenCalledTimes(1);
    const callArg = create.mock.calls[0][0];
    expect(callArg.response_format).toEqual({ type: "json_object" });
    // 1 text prompt + 2 images
    const userContent = callArg.messages[1].content as unknown[];
    expect(userContent).toHaveLength(3);
  });

  it("throws on empty response", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "" } }],
    });
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow("empty response");
  });

  it("throws on non-JSON response", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    });
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow("non-JSON");
  });

  it("throws on JSON that fails schema validation", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              total_minutes: "not a number",
              categories: [],
              apps: [],
            }),
          },
        },
      ],
    });
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow();
  });

  it("handles missing message content gracefully", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: {} }],
    });
    const fakeClient = {
      chat: { completions: { create } },
    } as unknown as import("openai").default;

    await expect(
      extractScreenTimeJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow("empty response");
  });
});

describe("processScreenTimePhotos", () => {
  function makeFakeClient(json: unknown) {
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

  it("rejects when caption is invalid", async () => {
    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "bad" }],
      caption: "bad",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_caption");
    expect(mocks.upsertDailyScreenTime).not.toHaveBeenCalled();
  });

  it("rejects when photos array is empty", async () => {
    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [],
      caption: "screen_time 2026-05-03",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_photos");
  });

  it("ingests successfully and notifies on a happy path", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockResolvedValue({});
    const notify = vi.fn().mockResolvedValue(undefined);

    const fakeClient = makeFakeClient({
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
        { fileId: "p1", caption: "screen_time 2026-05-03" },
        { fileId: "p2", caption: "" },
      ],
      caption: "screen_time 2026-05-03",
      openai: fakeClient,
      notify,
    });

    expect(result).toEqual({ ok: true, date: "2026-05-03" });
    expect(mocks.fetchTelegramFile).toHaveBeenCalledTimes(2);
    expect(mocks.upsertDailyScreenTime).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        date: "2026-05-03",
        totalMinutes: 125,
        firstPickup: "07:30:00",
        sourceMessageId: 42,
      })
    );
    expect(notify).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Screen Time saved for 2026-05-03")
    );
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ ok: true, action: "ingest" })
    );
  });

  it("handles HH:MM:SS first_pickup without re-padding", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    mocks.upsertDailyScreenTime.mockResolvedValue({});

    const fakeClient = makeFakeClient({
      total_minutes: 60,
      categories: [],
      apps: [],
      first_pickup: "07:30:15",
    });

    await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "screen_time 2026-05-03" }],
      caption: "screen_time 2026-05-03",
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
    mocks.upsertDailyScreenTime.mockResolvedValue({});
    const notify = vi.fn().mockResolvedValue(undefined);

    const fakeClient = makeFakeClient({
      total_minutes: 125,
      categories: [],
      apps: [],
    });

    await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "screen_time 2026-05-03" }],
      caption: "screen_time 2026-05-03",
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
    mocks.upsertDailyScreenTime.mockResolvedValue({});
    const notify = vi.fn().mockResolvedValue(undefined);

    const fakeClient = makeFakeClient({
      total_minutes: 45,
      categories: [],
      apps: [],
    });

    await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "screen_time 2026-05-03" }],
      caption: "screen_time 2026-05-03",
      openai: fakeClient,
      notify,
    });

    expect(notify).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("45m total")
    );
  });

  it("logs failure and notifies on extraction error", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const notify = vi.fn().mockResolvedValue(undefined);

    const fakeClient = {
      chat: {
        completions: {
          create: vi
            .fn()
            .mockRejectedValue(new Error("vision exploded")),
        },
      },
    } as unknown as import("openai").default;

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "screen_time 2026-05-03" }],
      caption: "screen_time 2026-05-03",
      openai: fakeClient,
      notify,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("vision exploded");
    expect(mocks.upsertDailyScreenTime).not.toHaveBeenCalled();
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

    const fakeClient = {
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error("boom")),
        },
      },
    } as unknown as import("openai").default;

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "screen_time 2026-05-03" }],
      caption: "screen_time 2026-05-03",
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
    mocks.upsertDailyScreenTime.mockResolvedValue({});

    const fakeClient = makeFakeClient({
      total_minutes: 30,
      categories: [],
      apps: [],
    });

    const result = await processScreenTimePhotos({
      pool: mockPool,
      chatId: "100",
      messageId: 1,
      photos: [{ fileId: "p1", caption: "screen_time 2026-05-03" }],
      caption: "screen_time 2026-05-03",
      openai: fakeClient,
    });

    expect(result.ok).toBe(true);
  });
});
