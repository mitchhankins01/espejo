import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTelegramFile: vi.fn(),
  logUsage: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: { botToken: "123:ABC" },
    openai: { apiKey: "sk-test" },
    models: { openaiVision: "gpt-4.1" },
  },
}));

vi.mock("../../src/telegram/media.js", () => ({
  fetchTelegramFile: mocks.fetchTelegramFile,
}));

vi.mock("../../src/db/queries/usage.js", () => ({
  logUsage: mocks.logUsage,
}));

import {
  extractFoodScreenJson,
  formatFoodReply,
  processFoodPhotos,
  type FoodScreenJson,
} from "../../src/telegram/food-screen.js";

const mockPool = {} as unknown as import("pg").Pool;

function makeJson(overrides: Partial<FoodScreenJson> = {}): FoodScreenJson {
  return {
    is_food: true,
    verdict: "SAFE",
    item: "grilled salmon with rice",
    reasons: ["No gluten-containing ingredients visible"],
    ask: null,
    uncertainty: null,
    ...overrides,
  };
}

function buildResponse(payload: unknown): {
  choices: { message: { content: string } }[];
} {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

function makeFakeClient(payload: unknown): import("openai").default {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue(buildResponse(payload)),
      },
    },
  } as unknown as import("openai").default;
}

beforeEach(() => {
  mocks.fetchTelegramFile.mockReset();
  mocks.logUsage.mockReset();
});

describe("extractFoodScreenJson", () => {
  it("parses a valid food screen payload and sends profile + images", async () => {
    const create = vi.fn().mockResolvedValue(
      buildResponse(
        makeJson({
          verdict: "AVOID",
          item: "breaded chicken",
          reasons: ["Breading is wheat flour (gluten)"],
        })
      )
    );
    const fakeClient = { chat: { completions: { create } } } as unknown as
      import("openai").default;

    const { json, raw } = await extractFoodScreenJson(
      [Buffer.from("a"), Buffer.from("b")],
      fakeClient
    );

    expect(json.is_food).toBe(true);
    expect(json.verdict).toBe("AVOID");
    expect(raw).toContain("AVOID");
    expect(create).toHaveBeenCalledTimes(1);
    const callArg = create.mock.calls[0][0];
    expect(callArg.response_format).toEqual({ type: "json_object" });
    // 1 text prompt + 2 images
    const userContent = callArg.messages[1].content as unknown[];
    expect(userContent).toHaveLength(3);
    // Profile rules are woven into the prompt.
    expect((userContent[0] as { text: string }).text).toContain("Gluten");
    expect((userContent[0] as { text: string }).text).toContain("TOLERANT");
  });

  it("parses a non-food response with nulls", async () => {
    const fakeClient = makeFakeClient({
      is_food: false,
      verdict: null,
      item: null,
      reasons: null,
      ask: null,
      uncertainty: null,
    });

    const { json } = await extractFoodScreenJson([Buffer.from("a")], fakeClient);
    expect(json.is_food).toBe(false);
    expect(json.verdict).toBeNull();
  });

  it("throws on empty response", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    await expect(
      extractFoodScreenJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow("empty response");
  });

  it("throws on missing message content", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({ choices: [{ message: {} }] }),
        },
      },
    } as unknown as import("openai").default;

    await expect(
      extractFoodScreenJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow("empty response");
  });

  it("throws on non-JSON response", async () => {
    const fakeClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "not json" } }],
          }),
        },
      },
    } as unknown as import("openai").default;

    await expect(
      extractFoodScreenJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow("non-JSON");
  });

  it("throws on JSON that fails schema validation", async () => {
    const fakeClient = makeFakeClient({
      is_food: "yes", // wrong type
      verdict: "MAYBE", // not in enum
    });

    await expect(
      extractFoodScreenJson([Buffer.from("a")], fakeClient)
    ).rejects.toThrow();
  });
});

describe("formatFoodReply", () => {
  it("renders verdict emoji, item, reasons, ask, and uncertainty", () => {
    const text = formatFoodReply(
      makeJson({
        verdict: "CAUTION",
        item: "pad thai",
        reasons: ["Sauce may contain soy sauce (gluten)", "  "],
        ask: "Is the sauce made with regular soy sauce or tamari?",
        uncertainty: "Can't see whether the noodles are rice or wheat",
      })
    );
    expect(text).toContain("⚠️ CAUTION — pad thai");
    expect(text).toContain("• Sauce may contain soy sauce (gluten)");
    // blank reason is filtered out
    expect(text).not.toContain("• \n");
    expect(text).toContain("❓ Is the sauce made");
    expect(text).toContain("🔍 Can't see whether");
  });

  it("uses the SAFE emoji and omits empty optional lines", () => {
    const text = formatFoodReply(
      makeJson({ verdict: "SAFE", reasons: [], ask: null, uncertainty: null })
    );
    expect(text).toBe("✅ SAFE — grilled salmon with rice");
  });

  it("coerces a null verdict to CAUTION and handles a missing item", () => {
    const text = formatFoodReply(
      makeJson({ verdict: null, item: null, reasons: null })
    );
    expect(text).toBe("⚠️ CAUTION");
  });

  it("renders the AVOID emoji", () => {
    const text = formatFoodReply(makeJson({ verdict: "AVOID", item: "beer" }));
    expect(text).toContain("❌ AVOID — beer");
  });
});

describe("processFoodPhotos", () => {
  it("rejects when photos array is empty", async () => {
    const result = await processFoodPhotos({
      pool: mockPool,
      chatId: "100",
      photos: [],
    });
    expect(result).toEqual({ ok: false, isFood: false, error: "no_photos" });
    expect(mocks.logUsage).not.toHaveBeenCalled();
  });

  it("returns isFood=false and logs detect when the model says it's not food", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const fakeClient = makeFakeClient({
      is_food: false,
      verdict: null,
      item: null,
      reasons: null,
      ask: null,
      uncertainty: null,
    });
    const notify = vi.fn();

    const result = await processFoodPhotos({
      pool: mockPool,
      chatId: "100",
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
      notify,
    });

    expect(result).toEqual({ ok: true, isFood: false });
    expect(notify).not.toHaveBeenCalled();
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        surface: "food-screen",
        action: "detect",
        ok: true,
        meta: expect.objectContaining({ is_food: false }),
      })
    );
  });

  it("falls through (isFood=false) when the vision call throws", async () => {
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

    const result = await processFoodPhotos({
      pool: mockPool,
      chatId: "100",
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(result.ok).toBe(false);
    expect(result.isFood).toBe(false);
    expect(result.error).toContain("vision exploded");
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ action: "detect", ok: false })
    );
  });

  it("screens food, notifies with the verdict, and logs screen", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const fakeClient = makeFakeClient(
      makeJson({
        verdict: "AVOID",
        item: "wheat crackers",
        reasons: ["Ingredient list lists wheat flour (gluten)"],
      })
    );

    const result = await processFoodPhotos({
      pool: mockPool,
      chatId: "100",
      photos: [
        { fileId: "p1", caption: "" },
        { fileId: "p2", caption: "" },
      ],
      openai: fakeClient,
      notify,
    });

    expect(result).toEqual({ ok: true, isFood: true, verdict: "AVOID" });
    expect(mocks.fetchTelegramFile).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("❌ AVOID — wheat crackers")
    );
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        action: "screen",
        ok: true,
        meta: expect.objectContaining({ verdict: "AVOID" }),
      })
    );
  });

  it("coerces a null verdict to CAUTION in result and log", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const fakeClient = makeFakeClient(makeJson({ verdict: null }));

    const result = await processFoodPhotos({
      pool: mockPool,
      chatId: "100",
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(result.verdict).toBe("CAUTION");
    expect(mocks.logUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ meta: expect.objectContaining({ verdict: "CAUTION" }) })
    );
  });

  it("succeeds without a notify callback", async () => {
    mocks.fetchTelegramFile.mockResolvedValue({
      buffer: Buffer.from("img"),
      filePath: "x.jpg",
    });
    const fakeClient = makeFakeClient(makeJson({ verdict: "SAFE" }));

    const result = await processFoodPhotos({
      pool: mockPool,
      chatId: "100",
      photos: [{ fileId: "p1", caption: "" }],
      openai: fakeClient,
    });

    expect(result).toEqual({ ok: true, isFood: true, verdict: "SAFE" });
  });
});
