import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockRunAgent,
  mockForceCompact,
  mockSendTelegramMessage,
  mockSendTelegramVoice,
  mockSendChatAction,
  mockTranscribeVoiceMessage,
  mockSynthesizeVoiceReply,
  mockExtractTextFromImage,
  mockExtractTextFromDocument,
  mockSetMessageHandler,
  mockProcessUpdate,
  mockGetSoulState,
  mockGetSoulQualityStats,
  mockGetLastAssistantMessageId,
  mockInsertSoulQualitySignal,
  mockGetLastPulseCheck,
  mockGetRetentionByInterval,
  mockGetVocabularyFunnel,
  mockGetGradeTrend,
  mockGetLapseRateTrend,
  mockGetSpanishQuizStats,
  mockGetSpanishAdaptiveContext,
  mockGetLatestSpanishAssessment,
  mockAssessSpanishQuality,
  mockGetOuraSyncRun,
  mockGetActivityLog,
  mockInsertChatMessage,
  mockConfig,
} = vi.hoisted(() => ({
  mockRunAgent: vi.fn().mockResolvedValue({ response: "agent response", activity: "", activityLogId: null, soulVersion: 1, patternCount: 0 }),
  mockForceCompact: vi.fn().mockResolvedValue(undefined),
  mockSendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  mockSendTelegramVoice: vi.fn().mockResolvedValue(true),
  mockSendChatAction: vi.fn().mockResolvedValue(undefined),
  mockTranscribeVoiceMessage: vi.fn().mockResolvedValue("transcribed text"),
  mockSynthesizeVoiceReply: vi.fn().mockResolvedValue(Buffer.from("voice")),
  mockExtractTextFromImage: vi.fn().mockResolvedValue("image text"),
  mockExtractTextFromDocument: vi.fn().mockResolvedValue("document text"),
  mockSetMessageHandler: vi.fn(),
  mockProcessUpdate: vi.fn(),
  mockGetSoulState: vi.fn().mockResolvedValue(null),
  mockGetSoulQualityStats: vi.fn().mockResolvedValue({
    felt_personal: 0, felt_generic: 0, correction: 0, positive_reaction: 0, total: 0, personal_ratio: 0,
  }),
  mockGetLastAssistantMessageId: vi.fn().mockResolvedValue(42),
  mockInsertSoulQualitySignal: vi.fn().mockResolvedValue({ id: 1 }),
  mockGetLastPulseCheck: vi.fn().mockResolvedValue(null),
  mockGetRetentionByInterval: vi.fn().mockResolvedValue([]),
  mockGetVocabularyFunnel: vi.fn().mockResolvedValue([]),
  mockGetGradeTrend: vi.fn().mockResolvedValue([]),
  mockGetLapseRateTrend: vi.fn().mockResolvedValue([]),
  mockGetSpanishQuizStats: vi.fn().mockResolvedValue({ total_words: 10, due_now: 2, new_words: 3, learning_words: 4, review_words: 2, relearning_words: 1, reviews_today: 5, average_grade: 3.0 }),
  mockGetSpanishAdaptiveContext: vi.fn().mockResolvedValue({ recent_avg_grade: 3.0, recent_lapse_rate: 0.1, avg_difficulty: 4.0, total_reviews: 50, mastered_count: 5, struggling_count: 1 }),
  mockGetLatestSpanishAssessment: vi.fn().mockResolvedValue(null),
  mockAssessSpanishQuality: vi.fn().mockResolvedValue({
    assessment: { id: 1, overall_score: 3.6, assessed_at: new Date() },
    summary: "<b>Spanish Assessment</b>\nOverall: <b>3.6/5</b>",
  }),
  mockGetOuraSyncRun: vi.fn().mockResolvedValue(null),
  mockGetActivityLog: vi.fn().mockResolvedValue(null),
  mockInsertChatMessage: vi.fn().mockResolvedValue({ inserted: true, id: 1 }),
  mockConfig: {
    config: {
      telegram: {
        botToken: "test-bot-token",
        secretToken: "test-secret",
        allowedChatId: "100",
        voiceReplyMode: "off",
        voiceReplyEvery: 3,
        voiceReplyMinChars: 1,
        voiceReplyMaxChars: 450,
        voiceModel: "gpt-4o-mini-tts",
        voiceName: "alloy",
        soulEnabled: true,
        soulFeedbackEvery: 8,
      },
      openai: { apiKey: "test-openai-key", chatModel: "gpt-4o-mini" },
    },
  },
}));

vi.mock("../../src/telegram/agent.js", () => ({
  runAgent: mockRunAgent,
  forceCompact: mockForceCompact,
}));

vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  sendTelegramVoice: mockSendTelegramVoice,
  sendChatAction: mockSendChatAction,
}));

vi.mock("../../src/telegram/voice.js", () => ({
  transcribeVoiceMessage: mockTranscribeVoiceMessage,
  synthesizeVoiceReply: mockSynthesizeVoiceReply,
  normalizeVoiceText: (text: string) =>
    text
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim(),
}));

vi.mock("../../src/telegram/media.js", () => ({
  extractTextFromImage: mockExtractTextFromImage,
  extractTextFromDocument: mockExtractTextFromDocument,
}));

vi.mock("../../src/telegram/updates.js", () => ({
  setMessageHandler: mockSetMessageHandler,
  processUpdate: mockProcessUpdate,
}));

vi.mock("../../src/db/client.js", () => ({
  pool: {},
}));

vi.mock("../../src/db/queries.js", () => ({
  getSoulState: mockGetSoulState,
  getSoulQualityStats: mockGetSoulQualityStats,
  getLastAssistantMessageId: mockGetLastAssistantMessageId,
  insertSoulQualitySignal: mockInsertSoulQualitySignal,
  getLastPulseCheck: mockGetLastPulseCheck,
  getRetentionByInterval: mockGetRetentionByInterval,
  getVocabularyFunnel: mockGetVocabularyFunnel,
  getGradeTrend: mockGetGradeTrend,
  getLapseRateTrend: mockGetLapseRateTrend,
  getSpanishQuizStats: mockGetSpanishQuizStats,
  getSpanishAdaptiveContext: mockGetSpanishAdaptiveContext,
  getLatestSpanishAssessment: mockGetLatestSpanishAssessment,
  getOuraSyncRun: mockGetOuraSyncRun,
  getActivityLog: mockGetActivityLog,
  insertChatMessage: mockInsertChatMessage,
}));

vi.mock("../../src/spanish/assessment.js", () => ({
  assessSpanishQuality: mockAssessSpanishQuality,
  createOpenAIAssessmentClient: vi.fn(),
}));

vi.mock("../../src/config.js", () => mockConfig);

import {
  registerTelegramRoutes,
  clearWebhookChatModes,
  clearFeedbackCounters,
} from "../../src/telegram/webhook.js";

// ---------------------------------------------------------------------------
// Helpers — minimal Express-like mock
// ---------------------------------------------------------------------------

interface MockRoute {
  method: string;
  path: string;
  handler: (req: MockRequest, res: MockResponse) => void;
}

interface MockRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockResponse;
  json: (data: unknown) => void;
}

function createMockApp(): { app: { post: ReturnType<typeof vi.fn> }; routes: MockRoute[] } {
  const routes: MockRoute[] = [];
  const app = {
    post: vi.fn((path: string, handler: (req: MockRequest, res: MockResponse) => void) => {
      routes.push({ method: "POST", path, handler });
    }),
  };
  return { app, routes };
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
    },
  };
  return res;
}

function getRoute(routes: MockRoute[], path: string): MockRoute | undefined {
  return routes.find((r) => r.path === path);
}

function getHandler(): (msg: Record<string, unknown>) => Promise<void> {
  const { app } = createMockApp();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTelegramRoutes(app as any);
  return mockSetMessageHandler.mock.calls[0][0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockRunAgent.mockReset().mockResolvedValue({ response: "agent response", activity: "", activityLogId: null, soulVersion: 1, patternCount: 0 });
  mockSendTelegramMessage.mockReset().mockResolvedValue(undefined);
  mockSendTelegramVoice.mockReset().mockResolvedValue(true);
  mockSendChatAction.mockReset().mockResolvedValue(undefined);
  mockTranscribeVoiceMessage.mockReset().mockResolvedValue("transcribed text");
  mockSynthesizeVoiceReply.mockReset().mockResolvedValue(Buffer.from("voice"));
  mockExtractTextFromImage.mockReset().mockResolvedValue("image text");
  mockExtractTextFromDocument.mockReset().mockResolvedValue("document text");
  mockSetMessageHandler.mockReset();
  mockProcessUpdate.mockReset();
  mockGetSoulState.mockReset().mockResolvedValue(null);
  mockGetSoulQualityStats.mockReset().mockResolvedValue({
    felt_personal: 0, felt_generic: 0, correction: 0, positive_reaction: 0, total: 0, personal_ratio: 0,
  });
  mockGetLastAssistantMessageId.mockReset().mockResolvedValue(42);
  mockInsertSoulQualitySignal.mockReset().mockResolvedValue({ id: 1 });
  mockGetLastPulseCheck.mockReset().mockResolvedValue(null);
  mockGetOuraSyncRun.mockReset().mockResolvedValue(null);
  mockGetActivityLog.mockReset().mockResolvedValue(null);
  mockConfig.config.telegram.voiceReplyMode = "off";
  mockConfig.config.telegram.voiceReplyEvery = 3;
  mockConfig.config.telegram.voiceReplyMinChars = 1;
  mockConfig.config.telegram.voiceReplyMaxChars = 450;
  mockConfig.config.telegram.soulEnabled = true;
  mockConfig.config.telegram.soulFeedbackEvery = 8;
  clearWebhookChatModes();
  clearFeedbackCounters();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("registerTelegramRoutes", () => {
  it("registers POST /api/telegram route", () => {
    const { app, routes } = createMockApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTelegramRoutes(app as any);

    expect(app.post).toHaveBeenCalledWith("/api/telegram", expect.any(Function));
    expect(getRoute(routes, "/api/telegram")).toBeDefined();
  });

  it("calls setMessageHandler on registration", () => {
    const { app } = createMockApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTelegramRoutes(app as any);

    expect(mockSetMessageHandler).toHaveBeenCalledWith(expect.any(Function));
  });
});

describe("POST /api/telegram", () => {
  function setup(): { handler: MockRoute["handler"] } {
    const { app, routes } = createMockApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTelegramRoutes(app as any);
    const route = getRoute(routes, "/api/telegram")!;
    return { handler: route.handler };
  }

  it("rejects requests with missing secret token", () => {
    const { handler } = setup();
    const res = createMockRes();

    handler(
      { headers: {}, body: { update_id: 1 } },
      res
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(mockProcessUpdate).not.toHaveBeenCalled();
  });

  it("rejects requests with wrong secret token", () => {
    const { handler } = setup();
    const res = createMockRes();

    handler(
      { headers: { "x-telegram-bot-api-secret-token": "wrong" }, body: { update_id: 1 } },
      res
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(mockProcessUpdate).not.toHaveBeenCalled();
  });

  it("rejects requests from non-allowed chat_id", () => {
    const { handler } = setup();
    const res = createMockRes();

    handler(
      {
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: {
          update_id: 1,
          message: { message_id: 1, chat: { id: 999 }, text: "hi", date: 1000 },
        },
      },
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
    expect(mockProcessUpdate).not.toHaveBeenCalled();
  });

  it("rejects callback queries from non-allowed chat_id", () => {
    const { handler } = setup();
    const res = createMockRes();

    handler(
      {
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: {
          update_id: 1,
          callback_query: {
            id: "cb-1",
            message: { message_id: 1, chat: { id: 999 }, date: 1000 },
            data: "yes",
          },
        },
      },
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
    expect(mockProcessUpdate).not.toHaveBeenCalled();
  });

  it("accepts valid requests and dispatches processUpdate", () => {
    const { handler } = setup();
    const res = createMockRes();

    const update = {
      update_id: 1,
      message: { message_id: 1, chat: { id: 100 }, text: "hello", date: 1000 },
    };

    handler(
      {
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: update,
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockProcessUpdate).toHaveBeenCalledWith(update);
  });

  it("accepts allowed message_reaction updates", () => {
    const { handler } = setup();
    const res = createMockRes();

    const update = {
      update_id: 2,
      message_reaction: {
        chat: { id: 100 },
        date: 1001,
        message_id: 9,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    };

    handler(
      {
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: update,
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockProcessUpdate).toHaveBeenCalledWith(update);
  });

  it("allows updates without chat_id (e.g. bare update_id)", () => {
    const { handler } = setup();
    const res = createMockRes();

    const update = { update_id: 1 };

    handler(
      {
        headers: { "x-telegram-bot-api-secret-token": "test-secret" },
        body: update,
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockProcessUpdate).toHaveBeenCalledWith(update);
  });
});

describe("message handler", () => {
  it("sends typing indicator immediately", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendChatAction).toHaveBeenCalledWith("100", "typing");
  });

  it("sends a progress notice when agent work is slow", async () => {
    vi.useFakeTimers();
    try {
      let resolveAgent:
        | ((value: { response: string; activity: string; soulVersion: number; patternCount: number }) => void)
        | undefined;
      mockRunAgent.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAgent = resolve;
          })
      );

      const handler = getHandler();
      const pending = handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

      await vi.advanceTimersByTimeAsync(4700);
      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        "100",
        "<i>On it. Pulling data now...</i>"
      );

      expect(resolveAgent).toBeDefined();
      if (!resolveAgent) {
        throw new Error("resolveAgent was not initialized");
      }
      resolveAgent({
        response: "agent response",
        activity: "",
        soulVersion: 1,
        patternCount: 0,
      });
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires text messages through agent to client", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "hello world", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "100",
        message: "hello world",
        messageDate: 1000,
        onCompacted: expect.any(Function),
      })
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });

  it("skips processing when user message is a duplicate (webhook retry after restart)", async () => {
    mockInsertChatMessage.mockResolvedValueOnce({ inserted: false, id: null });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("appends activity line when present", async () => {
    mockRunAgent.mockResolvedValueOnce({
      response: "Found it!",
      activity: "used 3 memories (behavior, fact) | 2 tools (search_entries, get_entry)",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Found it!\n\n<i>used 3 memories (behavior, fact) | 2 tools (search_entries, get_entry)</i>"
    );
  });

  it("shows activity details button and removes inline details link", async () => {
    mockRunAgent.mockResolvedValueOnce({
      response: "Done.",
      activity:
        "used 3 memories (behavior, fact) | logged 2 spanish terms | <a href=\"https://example.com/api/activity/9\">details</a>",
      activityLogId: 9,
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Done.\n\n<i>used 3 memories (behavior, fact) | logged 2 spanish terms</i>",
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              text: "Details",
              callback_data: "activity_detail:9:3:2",
            }),
          ]),
        ]),
      })
    );
  });

  it("removes inline details link without adding button when no memory/term summary exists", async () => {
    mockRunAgent.mockResolvedValueOnce({
      response: "Done.",
      activity:
        "2 tools (search_entries, get_entry) | <a href=\"https://example.com/api/activity/10\">details</a>",
      activityLogId: 10,
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Done.\n\n<i>2 tools (search_entries, get_entry)</i>"
    );
  });

  it("does not append activity line when empty", async () => {
    mockRunAgent.mockResolvedValueOnce({ response: "Hi!", activity: "" });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "Hi!");
  });

  it("transcribes voice messages before sending to agent", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-123", durationSeconds: 5 },
    });

    expect(mockTranscribeVoiceMessage).toHaveBeenCalledWith("voice-123", 5);
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ message: "transcribed text" })
    );
  });

  it("replies with a voice note for voice-origin messages when adaptive mode is enabled", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-123", durationSeconds: 5 },
    });

    expect(mockSynthesizeVoiceReply).toHaveBeenCalledWith("agent response");
    expect(mockSendTelegramVoice).toHaveBeenCalledWith("100", expect.any(Buffer));
    expect(mockSendTelegramMessage).not.toHaveBeenCalledWith("100", "agent response");
  });

  it("sends voice activity text with details button when memory and term summary exists", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockRunAgent.mockResolvedValueOnce({
      response: "Found it.",
      activity:
        "used 2 memories (behavior) | logged 1 spanish terms | <a href=\"https://example.com/api/activity/7\">details</a>",
      activityLogId: 7,
    });

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-123", durationSeconds: 5 },
    });

    expect(mockSendTelegramVoice).toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>used 2 memories (behavior) | logged 1 spanish terms</i>",
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              text: "Details",
              callback_data: "activity_detail:7:2:1",
            }),
          ]),
        ]),
      })
    );
  });

  it("falls back to text when voice send fails", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockSendTelegramVoice.mockResolvedValueOnce(false);

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-123", durationSeconds: 5 },
    });

    expect(mockSendTelegramVoice).toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });

  it("falls back to text when voice synthesis throws", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockSynthesizeVoiceReply.mockRejectedValueOnce(new Error("tts down"));

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-123", durationSeconds: 5 },
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram voice reply failed [chat:100]:",
      expect.any(Error)
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });

  it("uses voice for short conversational text replies in adaptive mode", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).toHaveBeenCalledWith("agent response");
    expect(mockSendTelegramVoice).toHaveBeenCalled();
  });

  it("uses voice for friendly responses in always mode", async () => {
    mockConfig.config.telegram.voiceReplyMode = "always";
    mockRunAgent.mockResolvedValueOnce({ response: "Short natural response", activity: "" });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).toHaveBeenCalledWith("Short natural response");
    expect(mockSendTelegramVoice).toHaveBeenCalled();
  });

  it("keeps text when normalized response is empty", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockRunAgent.mockResolvedValueOnce({ response: "<b> </b>", activity: "" });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "<b> </b>");
  });

  it("keeps text when response is below voice min chars", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockConfig.config.telegram.voiceReplyMinChars = 30;
    mockRunAgent.mockResolvedValueOnce({ response: "too short", activity: "" });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
  });

  it("keeps text when response is above voice max chars", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockConfig.config.telegram.voiceReplyMaxChars = 20;
    mockRunAgent.mockResolvedValueOnce({
      response: "this response is definitely too long for voice",
      activity: "",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
  });

  it("keeps text for markdown/code style responses", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockRunAgent.mockResolvedValueOnce({
      response: "Use `pnpm check` before deploy.",
      activity: "",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
  });

  it("keeps text for bulleted list responses", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockRunAgent.mockResolvedValueOnce({
      response: "- first\n- second",
      activity: "",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
  });

  it("keeps text for numbered list responses", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockRunAgent.mockResolvedValueOnce({
      response: "1. first\n2. second",
      activity: "",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
  });

  it("keeps text for long structured lists", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockRunAgent.mockResolvedValueOnce({
      response: "1. one\n2. two\n3. three\n4. four\n5. five\n6. six",
      activity: "",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
  });

  it("keeps text when adaptive text reply exceeds cadence max length", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockConfig.config.telegram.voiceReplyMaxChars = 500;
    mockRunAgent.mockResolvedValueOnce({
      response: "x".repeat(300),
      activity: "",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
    expect(mockSendTelegramVoice).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "x".repeat(300));
  });

  it("keeps text output when response is not voice-friendly", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockRunAgent.mockResolvedValueOnce({
      response: "Use this link: https://example.com for the full answer",
      activity: "",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
    expect(mockSendTelegramVoice).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Use this link: https://example.com for the full answer"
    );
  });

  it("sends activity as text when the main response is sent as voice", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 1;
    mockRunAgent.mockResolvedValueOnce({
      response: "Found it!",
      activity: "3 patterns | 2 tools (search_entries, get_entry)",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramVoice).toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>3 patterns | 2 tools (search_entries, get_entry)</i>"
    );
  });

  it("uses text when adaptive cadence has not hit the configured interval", async () => {
    mockConfig.config.telegram.voiceReplyMode = "adaptive";
    mockConfig.config.telegram.voiceReplyEvery = 3;

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramVoice).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });

  it("extracts text from photo messages before sending to agent", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 2,
      date: 1000,
      photo: { fileId: "photo-123", caption: "read this" },
    });

    expect(mockExtractTextFromImage).toHaveBeenCalledWith("photo-123", "read this");
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ message: "image text" })
    );
  });

  it("returns helpful message when photo OCR returns empty text", async () => {
    mockExtractTextFromImage.mockResolvedValueOnce("");

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 20,
      date: 1000,
      photo: { fileId: "photo-124", caption: "" },
    });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "I couldn't extract any text from that image. Try a clearer image or add a caption."
    );
  });

  it("extracts text from document messages before sending to agent", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 3,
      date: 1000,
      document: {
        fileId: "doc-123",
        fileName: "notes.txt",
        mimeType: "text/plain",
        caption: "",
      },
    });

    expect(mockExtractTextFromDocument).toHaveBeenCalledWith({
      fileId: "doc-123",
      fileName: "notes.txt",
      mimeType: "text/plain",
      caption: "",
    });
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ message: "document text" })
    );
  });

  it("returns helpful message when document extraction returns empty text", async () => {
    mockExtractTextFromDocument.mockResolvedValueOnce("");

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 21,
      date: 1000,
      document: {
        fileId: "doc-empty",
        fileName: "empty.pdf",
        mimeType: "application/pdf",
        caption: "",
      },
    });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "I couldn't extract any text from that document."
    );
  });

  it("skips sending when agent returns null response", async () => {
    mockRunAgent.mockResolvedValueOnce({ response: null, activity: "" });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalled();
    // Only sendChatAction was called, not sendTelegramMessage
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("skips processing when text is empty and no voice", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 1, date: 1000 });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  it("sends actual error message to chat when agent throws", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("Anthropic rate limited"));

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram error [chat:100]:",
      expect.any(Error)
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Error: Anthropic rate limited"
    );
  });

  it("sends error message when voice transcription throws", async () => {
    mockTranscribeVoiceMessage.mockRejectedValueOnce(new Error("Whisper unavailable"));

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-1", durationSeconds: 3 },
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram error [chat:100]:",
      expect.any(Error)
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Error: Whisper unavailable"
    );
  });

  it("handles non-Error thrown values", async () => {
    mockRunAgent.mockRejectedValueOnce("string error");

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "Error: string error");
  });

  it("survives when error notification send also fails", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("API down"));
    mockSendTelegramMessage.mockRejectedValueOnce(new Error("Send failed too"));

    const handler = getHandler();
    // Should not throw
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram error [chat:100]:",
      expect.any(Error)
    );
  });

  it("handles /compact command without calling runAgent", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/compact", messageId: 1, date: 1000 });

    expect(mockForceCompact).toHaveBeenCalledWith("100", expect.any(Function));
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("/compact sends compaction summary to chat", async () => {
    mockForceCompact.mockImplementationOnce(async (_chatId: string, onCompacted: (s: string) => Promise<void>) => {
      await onCompacted("saved 2 memories (behavior, event) · reinforced 1");
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "/compact", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>Memory note: saved 2 memories (behavior, event) · reinforced 1</i>"
    );
  });

  it("treats bare slash text as a normal message", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "/",
        mode: "default",
      })
    );
  });

  it("handles /compact command with bot mention", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/compact@test_bot", messageId: 1, date: 1000 });

    expect(mockForceCompact).toHaveBeenCalledWith("100", expect.any(Function));
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("handles /compose command by injecting compose instruction and prefill into runAgent", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/compose", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    const call = mockRunAgent.mock.calls[0][0];
    expect(call.message).toBe("Write the entry now.");
    expect(call.prefill).toBe("#");
  });

  it("activates evening review mode with /evening", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/evening", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "evening_review",
      })
    );
    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.message).toContain("Start my evening review now.");
  });

  it("activates evening review mode with /evenning typo alias", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/evenning", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "evening_review",
      })
    );
    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.message).toContain("Start my evening review now.");
  });

  it("passes optional focus seed through /evening arguments", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "/evening work boundaries and escalera",
      messageId: 1,
      date: 1000,
    });

    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.mode).toBe("evening_review");
    expect(firstCall.message).toContain(
      "Focus tonight: work boundaries and escalera"
    );
  });

  it("keeps evening mode active for subsequent messages", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/evening", messageId: 1, date: 1000 });
    await handler({ chatId: 100, text: "today was intense", messageId: 2, date: 1001 });

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    const secondCall = mockRunAgent.mock.calls[1][0];
    expect(secondCall.mode).toBe("evening_review");
    expect(secondCall.message).toBe("today was intense");
  });

  it("deactivates evening mode with /evening off", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/evening", messageId: 1, date: 1000 });
    await handler({ chatId: 100, text: "/evening off", messageId: 2, date: 1001 });
    await handler({ chatId: 100, text: "back to normal", messageId: 3, date: 1002 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>Evening review mode off.</i>"
    );
    const thirdCall = mockRunAgent.mock.calls[1][0];
    expect(thirdCall.mode).toBe("default");
  });

  it("activates evening review mode from natural language request", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "Let’s do evening review ahora",
      messageId: 1,
      date: 1000,
    });

    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.mode).toBe("evening_review");
    expect(firstCall.message).toContain("Start my evening review now.");
  });

  it("does not hijack plain mentions of evening review", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "my evening review yesterday was pretty intense",
      messageId: 1,
      date: 1000,
    });

    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.mode).toBe("default");
    expect(firstCall.message).toBe("my evening review yesterday was pretty intense");
  });

  it("deactivates evening mode from natural-language stop phrase", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/evening", messageId: 1, date: 1000 });
    await handler({
      chatId: 100,
      text: "stop evening review",
      messageId: 2,
      date: 1001,
    });
    await handler({ chatId: 100, text: "back to normal", messageId: 3, date: 1002 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>Evening review mode off.</i>"
    );
    const thirdCall = mockRunAgent.mock.calls[1][0];
    expect(thirdCall.mode).toBe("default");
  });
});

describe("morning flow mode", () => {
  it("activates morning flow mode with /morning", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/morning", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "morning_flow",
      })
    );
    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.message).toContain("Start my morning flow now.");
  });

  it("passes optional focus seed through /morning arguments", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "/morning sleep and dreams",
      messageId: 1,
      date: 1000,
    });

    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.mode).toBe("morning_flow");
    expect(firstCall.message).toContain(
      "Focus this morning: sleep and dreams"
    );
  });

  it("keeps morning mode active for subsequent messages", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/morning", messageId: 1, date: 1000 });
    await handler({ chatId: 100, text: "slept terribly", messageId: 2, date: 1001 });

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    const secondCall = mockRunAgent.mock.calls[1][0];
    expect(secondCall.mode).toBe("morning_flow");
    expect(secondCall.message).toBe("slept terribly");
  });

  it("deactivates morning mode with /morning off", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/morning", messageId: 1, date: 1000 });
    await handler({ chatId: 100, text: "/morning off", messageId: 2, date: 1001 });
    await handler({ chatId: 100, text: "back to normal", messageId: 3, date: 1002 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>Morning flow mode off.</i>"
    );
    const thirdCall = mockRunAgent.mock.calls[1][0];
    expect(thirdCall.mode).toBe("default");
  });

  it("activates morning flow mode from natural language request", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "Let's do morning flow ahora",
      messageId: 1,
      date: 1000,
    });

    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.mode).toBe("morning_flow");
    expect(firstCall.message).toContain("Start my morning flow now.");
  });

  it("does not hijack plain mentions of morning flow", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "my morning flow yesterday was pretty intense",
      messageId: 1,
      date: 1000,
    });

    const firstCall = mockRunAgent.mock.calls[0][0];
    expect(firstCall.mode).toBe("default");
    expect(firstCall.message).toBe("my morning flow yesterday was pretty intense");
  });

  it("deactivates morning mode from natural-language stop phrase", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/morning", messageId: 1, date: 1000 });
    await handler({
      chatId: 100,
      text: "stop morning flow",
      messageId: 2,
      date: 1001,
    });
    await handler({ chatId: 100, text: "back to normal", messageId: 3, date: 1002 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>Morning flow mode off.</i>"
    );
    const thirdCall = mockRunAgent.mock.calls[1][0];
    expect(thirdCall.mode).toBe("default");
  });
});

describe("soul feedback buttons", () => {
  it("attaches inline buttons on every Nth message based on soulFeedbackEvery", async () => {
    mockConfig.config.telegram.soulFeedbackEvery = 2;

    const handler = getHandler();
    // Message 1: counter=1, not divisible by 2
    await handler({ chatId: 100, text: "first", messageId: 1, date: 1000 });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");

    mockSendTelegramMessage.mockClear();

    // Message 2: counter=2, divisible by 2 — should get buttons
    await handler({ chatId: 100, text: "second", messageId: 2, date: 1001 });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "agent response",
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ callback_data: "soul:personal" }),
            expect.objectContaining({ callback_data: "soul:generic" }),
          ]),
        ]),
      })
    );
  });

  it("does not attach buttons when soulEnabled is false", async () => {
    mockConfig.config.telegram.soulEnabled = false;
    mockConfig.config.telegram.soulFeedbackEvery = 1;

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });
});

describe("soul feedback callbacks", () => {
  it("handles soul:personal callback and inserts felt_personal signal", async () => {
    mockGetSoulState.mockResolvedValueOnce({ version: 5 });

    const handler = getHandler();
    await handler({ chatId: 100, text: "soul:personal", messageId: 10, date: 1000, callbackData: "soul:personal" });

    expect(mockInsertSoulQualitySignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: "100",
        signalType: "felt_personal",
        soulVersion: 5,
        metadata: { source: "inline_button" },
      })
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Noted")
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("handles soul:generic callback and inserts felt_generic signal", async () => {
    mockGetSoulState.mockResolvedValueOnce({ version: 3 });

    const handler = getHandler();
    await handler({ chatId: 100, text: "soul:generic", messageId: 11, date: 1000, callbackData: "soul:generic" });

    expect(mockInsertSoulQualitySignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: "100",
        signalType: "felt_generic",
        soulVersion: 3,
        metadata: { source: "inline_button" },
      })
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("defaults callback soulVersion to 0 when no soul state exists", async () => {
    mockGetSoulState.mockResolvedValueOnce(null);

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "soul:personal",
      messageId: 12,
      date: 1000,
      callbackData: "soul:personal",
    });

    expect(mockInsertSoulQualitySignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        soulVersion: 0,
      })
    );
  });

  it("handles soul feedback callback error gracefully", async () => {
    mockGetSoulState.mockRejectedValueOnce(new Error("db down"));

    const handler = getHandler();
    await handler({ chatId: 100, text: "soul:personal", messageId: 10, date: 1000, callbackData: "soul:personal" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("soul feedback error"),
      expect.any(Error)
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});

describe("message reactions", () => {
  it("logs positive reaction as positive_reaction signal", async () => {
    mockGetSoulState.mockResolvedValueOnce({ version: 4 });

    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 5, date: 1000, reactionEmoji: "👍" });

    expect(mockInsertSoulQualitySignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signalType: "positive_reaction",
        metadata: { source: "reaction", emoji: "👍" },
      })
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockSendChatAction).not.toHaveBeenCalled();
  });

  it("logs negative reaction as felt_generic signal", async () => {
    mockGetSoulState.mockResolvedValueOnce({ version: 2 });

    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 5, date: 1000, reactionEmoji: "👎" });

    expect(mockInsertSoulQualitySignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signalType: "felt_generic",
        metadata: { source: "reaction", emoji: "👎" },
      })
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("defaults reaction soulVersion to 0 when no soul state exists", async () => {
    mockGetSoulState.mockResolvedValueOnce(null);

    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 6, date: 1000, reactionEmoji: "👍" });

    expect(mockInsertSoulQualitySignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        signalType: "positive_reaction",
        soulVersion: 0,
      })
    );
  });

  it("ignores unknown reaction emojis", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 5, date: 1000, reactionEmoji: "🤷" });

    expect(mockInsertSoulQualitySignal).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("skips reaction logging when soulEnabled is false", async () => {
    mockConfig.config.telegram.soulEnabled = false;

    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 5, date: 1000, reactionEmoji: "👍" });

    expect(mockInsertSoulQualitySignal).not.toHaveBeenCalled();
  });

  it("handles reaction signal error gracefully", async () => {
    mockGetSoulState.mockRejectedValueOnce(new Error("db fail"));

    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 5, date: 1000, reactionEmoji: "❤️" });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("reaction signal error"),
      expect.any(Error)
    );
  });
});

describe("/soul command", () => {
  it("displays soul state and quality stats", async () => {
    mockGetSoulState.mockResolvedValueOnce({
      version: 7,
      identity_summary: "A steady companion.",
      relational_commitments: ["stay direct", "be concise"],
      tone_signature: ["warm", "grounded"],
      growth_notes: ["user prefers specifics"],
    });
    mockGetSoulQualityStats.mockResolvedValueOnce({
      felt_personal: 10,
      felt_generic: 2,
      correction: 5,
      positive_reaction: 8,
      total: 25,
      personal_ratio: 0.9,
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "/soul", messageId: 1, date: 1000 });

    expect(mockRunAgent).not.toHaveBeenCalled();
    const sentMessage = mockSendTelegramMessage.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => typeof c[1] === "string" && c[1].includes("Soul State")
    );
    expect(sentMessage).toBeDefined();
    const text = sentMessage![1] as string;
    expect(text).toContain("v7");
    expect(text).toContain("A steady companion.");
    expect(text).toContain("stay direct, be concise");
    expect(text).toContain("warm, grounded");
    expect(text).toContain("Felt personal: 10");
    expect(text).toContain("Felt generic: 2");
    expect(text).toContain("90%");
  });

  it("shows fallback when no soul state exists", async () => {
    mockGetSoulState.mockResolvedValueOnce(null);
    mockGetSoulQualityStats.mockResolvedValueOnce({
      felt_personal: 0, felt_generic: 0, correction: 0, positive_reaction: 0, total: 0, personal_ratio: 0,
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "/soul", messageId: 1, date: 1000 });

    expect(mockRunAgent).not.toHaveBeenCalled();
    const sentMessage = mockSendTelegramMessage.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => typeof c[1] === "string" && c[1].includes("Soul State")
    );
    expect(sentMessage).toBeDefined();
    expect(sentMessage![1] as string).toContain("No soul state yet");
  });

  it("includes pulse status and applied repair count when available", async () => {
    mockGetSoulState.mockResolvedValueOnce({
      version: 4,
      identity_summary: "Grounded and specific.",
      relational_commitments: ["be concrete"],
      tone_signature: ["warm"],
      growth_notes: [],
    });
    mockGetSoulQualityStats.mockResolvedValueOnce({
      felt_personal: 6,
      felt_generic: 3,
      correction: 1,
      positive_reaction: 2,
      total: 12,
      personal_ratio: 0.73,
    });
    mockGetLastPulseCheck.mockResolvedValueOnce({
      id: 11,
      chat_id: "100",
      status: "drifting",
      personal_ratio: 0.31,
      correction_rate: 0.1,
      signal_counts: {
        felt_personal: 1,
        felt_generic: 6,
        correction: 1,
        positive_reaction: 1,
        total: 9,
      },
      repairs_applied: [{ type: "add_growth_note" }, { type: "add_commitment" }],
      soul_version_before: 3,
      soul_version_after: 4,
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "/soul", messageId: 1, date: 1000 });

    const sentMessage = mockSendTelegramMessage.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => typeof c[1] === "string" && c[1].includes("<b>Pulse:</b>")
    );
    expect(sentMessage).toBeDefined();
    const text = sentMessage![1] as string;
    expect(text).toContain("<b>Pulse:</b>");
    expect(text).toContain("drifting");
    expect(text).toContain("Repairs: 2 applied");
  });

  it("uses fallback pulse emoji for unknown pulse status", async () => {
    mockGetSoulState.mockResolvedValueOnce({
      version: 2,
      identity_summary: "Calm and direct.",
      relational_commitments: [],
      tone_signature: [],
      growth_notes: [],
    });
    mockGetSoulQualityStats.mockResolvedValueOnce({
      felt_personal: 0,
      felt_generic: 0,
      correction: 0,
      positive_reaction: 0,
      total: 0,
      personal_ratio: 0,
    });
    mockGetLastPulseCheck.mockResolvedValueOnce({
      id: 12,
      chat_id: "100",
      status: "mystery",
      personal_ratio: 0,
      correction_rate: 0,
      signal_counts: {},
      repairs_applied: [],
      soul_version_before: 2,
      soul_version_after: 2,
      created_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "/soul", messageId: 1, date: 1000 });

    const sentMessage = mockSendTelegramMessage.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => typeof c[1] === "string" && c[1].includes("<b>Pulse:</b>")
    );
    expect(sentMessage).toBeDefined();
    expect(sentMessage![1] as string).toContain("<b>Pulse:</b> ❓ mystery");
  });

  it("handles /soul error gracefully", async () => {
    mockGetSoulState.mockRejectedValueOnce(new Error("db error"));

    const handler = getHandler();
    await handler({ chatId: 100, text: "/soul", messageId: 1, date: 1000 });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("/soul error"),
      expect.any(Error)
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Error loading soul state."
    );
  });

  // =========================================================================
  // /digest command
  // =========================================================================

  it("/digest sends Spanish learning summary", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/digest", messageId: 1, date: 1000 });

    expect(mockGetSpanishQuizStats).toHaveBeenCalled();
    expect(mockGetSpanishAdaptiveContext).toHaveBeenCalled();
    expect(mockGetRetentionByInterval).toHaveBeenCalled();
    expect(mockGetVocabularyFunnel).toHaveBeenCalled();
    expect(mockGetGradeTrend).toHaveBeenCalled();
    expect(mockGetLapseRateTrend).toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Spanish Learning Digest")
    );
    // Should not dispatch to agent
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("/digest handles errors gracefully", async () => {
    mockGetSpanishQuizStats.mockRejectedValueOnce(new Error("db error"));

    const handler = getHandler();
    await handler({ chatId: 100, text: "/digest", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Error generating digest."
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // =========================================================================
  // /assess command
  // =========================================================================

  it("/assess triggers LLM assessment and sends summary", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/assess", messageId: 1, date: 1000 });

    expect(mockSendChatAction).toHaveBeenCalledWith("100", "typing");
    expect(mockAssessSpanishQuality).toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("3.6/5")
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("/assess handles errors gracefully", async () => {
    mockAssessSpanishQuality.mockRejectedValueOnce(
      new Error("Not enough user messages")
    );

    const handler = getHandler();
    await handler({ chatId: 100, text: "/assess", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Not enough user messages")
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("/assess handles non-Error exceptions", async () => {
    mockAssessSpanishQuality.mockRejectedValueOnce("string error");

    const handler = getHandler();
    await handler({ chatId: 100, text: "/assess", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("string error")
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});

describe("activity_detail callback", () => {
  it("sends formatted detail message for a valid activity log", async () => {
    mockGetActivityLog.mockResolvedValueOnce({
      id: 9,
      chat_id: "100",
      memories: [
        {
          id: 1,
          content:
            "I am building stronger routines around sleep and focus, and this sentence is intentionally long so the detail formatter has to truncate the preview output for Telegram.",
          kind: "behavior",
          confidence: 0.9,
          score: 0.95,
        },
        {
          id: 2,
          content: "Short memory note.",
          kind: "fact",
          confidence: 0.8,
          score: 0.88,
        },
      ],
      tool_calls: [
        {
          name: "search_entries",
          args: { query: "sleep" },
          result: "raw tool result",
          truncated_result: "truncated",
        },
      ],
      cost_usd: 0.123,
      created_at: new Date("2026-02-22T08:30:00Z"),
    });

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:9:3:2",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:9:3:2",
    });

    expect(mockGetActivityLog).toHaveBeenCalledWith(expect.anything(), 9);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Activity detail #9")
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("memories used: 3")
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("spanish terms logged: 2")
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns not found when activity log does not exist", async () => {
    mockGetActivityLog.mockResolvedValueOnce(null);

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:99:1:1",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:99:1:1",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Activity run #99 not found."
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns not found when activity log belongs to another chat", async () => {
    mockGetActivityLog.mockResolvedValueOnce({
      id: 12,
      chat_id: "999",
      memories: [],
      tool_calls: [],
      cost_usd: null,
      created_at: new Date("2026-02-22T08:30:00Z"),
    });

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:12:1:0",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:12:1:0",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Activity run #12 not found."
    );
  });

  it("handles invalid activity detail IDs", async () => {
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:abc:1:1",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:abc:1:1",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Activity detail not found."
    );
    expect(mockGetActivityLog).not.toHaveBeenCalled();
  });

  it("formats detail summary without sections when memories and tools are empty", async () => {
    mockGetActivityLog.mockResolvedValueOnce({
      id: 11,
      chat_id: "100",
      memories: [],
      tool_calls: [],
      cost_usd: null,
      created_at: new Date("2026-02-22T08:30:00Z"),
    });

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:11:0:0",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:11:0:0",
    });

    const sentMessage = mockSendTelegramMessage.mock.calls.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any[]) => typeof c[1] === "string" && c[1].includes("Activity detail #11")
    );
    expect(sentMessage).toBeDefined();
    const detail = sentMessage![1] as string;
    expect(detail).toContain("memories used: 0");
    expect(detail).toContain("spanish terms logged: 0");
    expect(detail).not.toContain("Top memories:");
    expect(detail).not.toContain("Tools:");
  });

  it("handles activity detail callback errors gracefully", async () => {
    mockGetActivityLog.mockRejectedValueOnce(new Error("db down"));

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:9:1:1",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:9:1:1",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("activity_detail callback error"),
      expect.any(Error)
    );
  });
});

describe("oura_sync callback", () => {
  it("sends detail message with sync run info", async () => {
    mockGetOuraSyncRun.mockResolvedValueOnce({
      id: 42,
      started_at: "2025-06-15T14:00:00Z",
      finished_at: "2025-06-15T14:00:08Z",
      status: "success",
      records_synced: 368,
      error: null,
    });

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "oura_sync:42:31,72,31,30,31,173",
      messageId: 10,
      date: 1000,
      callbackData: "oura_sync:42:31,72,31,30,31,173",
    });

    expect(mockGetOuraSyncRun).toHaveBeenCalledWith(expect.anything(), 42);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Oura sync #42")
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("sleep: 31")
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("handles null finished_at", async () => {
    mockGetOuraSyncRun.mockResolvedValueOnce({
      id: 43,
      started_at: "2025-06-15T14:00:00Z",
      finished_at: null,
      status: "running",
      records_synced: 0,
      error: null,
    });

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "oura_sync:43:0,0,0,0,0,0",
      messageId: 10,
      date: 1000,
      callbackData: "oura_sync:43:0,0,0,0,0,0",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("in progress")
    );
  });

  it("shows not found when run is missing", async () => {
    mockGetOuraSyncRun.mockResolvedValueOnce(null);

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "oura_sync:999:0,0,0,0,0,0",
      messageId: 10,
      date: 1000,
      callbackData: "oura_sync:999:0,0,0,0,0,0",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Oura sync run #999 not found."
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("includes error in detail when present", async () => {
    mockGetOuraSyncRun.mockResolvedValueOnce({
      id: 44,
      started_at: "2025-06-15T14:00:00Z",
      finished_at: "2025-06-15T14:00:02Z",
      status: "failed",
      records_synced: 0,
      error: "API rate limited",
    });

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "oura_sync:44:0,0,0,0,0,0",
      messageId: 10,
      date: 1000,
      callbackData: "oura_sync:44:0,0,0,0,0,0",
    });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("API rate limited")
    );
  });

  it("handles error in callback gracefully", async () => {
    mockGetOuraSyncRun.mockRejectedValueOnce(new Error("db down"));

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "oura_sync:42:0,0,0,0,0,0",
      messageId: 10,
      date: 1000,
      callbackData: "oura_sync:42:0,0,0,0,0,0",
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("oura_sync callback error"),
      expect.any(Error)
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});
