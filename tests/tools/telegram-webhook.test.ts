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
  mockConfig,
} = vi.hoisted(() => ({
  mockRunAgent: vi.fn().mockResolvedValue({ response: "agent response", activity: "", soulVersion: 1, patternCount: 0 }),
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
  mockRunAgent.mockReset().mockResolvedValue({ response: "agent response", activity: "", soulVersion: 1, patternCount: 0 });
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

  it("wires text messages through agent to client", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "hello world", messageId: 1, date: 1000 });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "100",
        message: "hello world",
        externalMessageId: "1",
        messageDate: 1000,
        onCompacted: expect.any(Function),
      })
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
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
});
