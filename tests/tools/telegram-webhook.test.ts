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
  mockGetOuraSyncRun,
  mockGetActivityLog,
  mockInsertChatMessage,
  mockIsPracticeSessionActive,
  mockStartPracticeSession,
  mockEndPracticeSession,
  mockRunPracticeExtraction,
  mockBuildSpanishPracticeSystemPrompt,
  mockConfig,
} = vi.hoisted(() => ({
  mockRunAgent: vi.fn().mockResolvedValue({ response: "agent response", activity: "", activityLogId: null,  }),
  mockForceCompact: vi.fn().mockResolvedValue(undefined),
  mockSendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  mockSendTelegramVoice: vi.fn().mockResolvedValue(true),
  mockSendChatAction: vi.fn().mockResolvedValue(undefined),
  mockTranscribeVoiceMessage: vi.fn().mockResolvedValue("transcribed text"),
  mockSynthesizeVoiceReply: vi.fn().mockResolvedValue(Buffer.from("audio")),
  mockExtractTextFromImage: vi.fn().mockResolvedValue("image text"),
  mockExtractTextFromDocument: vi.fn().mockResolvedValue("document text"),
  mockSetMessageHandler: vi.fn(),
  mockProcessUpdate: vi.fn(),
  mockGetOuraSyncRun: vi.fn().mockResolvedValue(null),
  mockGetActivityLog: vi.fn().mockResolvedValue(null),
  mockInsertChatMessage: vi.fn().mockResolvedValue({ inserted: true, id: 1 }),
  mockIsPracticeSessionActive: vi.fn().mockReturnValue(false),
  mockStartPracticeSession: vi.fn().mockReturnValue({ sessionId: "abc123", startedAt: new Date() }),
  mockEndPracticeSession: vi.fn().mockReturnValue({ sessionId: "abc123", startedAt: new Date() }),
  mockRunPracticeExtraction: vi.fn().mockResolvedValue({
    diffSummary: "- No significant changes.",
    messageCount: 4,
    wrotePersisted: true,
  }),
  mockBuildSpanishPracticeSystemPrompt: vi.fn().mockResolvedValue("PRACTICE PROMPT"),
  mockConfig: {
    config: {
      telegram: {
        botToken: "test-bot-token",
        secretToken: "test-secret",
        allowedChatId: "100",
        voiceModel: "gpt-4o-mini-tts",
        voiceName: "alloy",
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
}));

vi.mock("../../src/telegram/practice-session.js", () => ({
  isPracticeSessionActive: mockIsPracticeSessionActive,
  startPracticeSession: mockStartPracticeSession,
  endPracticeSession: mockEndPracticeSession,
  runPracticeExtraction: mockRunPracticeExtraction,
}));

vi.mock("../../src/prompts/spanish-practice.js", () => ({
  buildSpanishPracticeSystemPrompt: mockBuildSpanishPracticeSystemPrompt,
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
  getOuraSyncRun: mockGetOuraSyncRun,
  getActivityLog: mockGetActivityLog,
  insertChatMessage: mockInsertChatMessage,
}));

vi.mock("../../src/config.js", () => mockConfig);

import {
  registerTelegramRoutes,
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
  mockRunAgent.mockReset().mockResolvedValue({ response: "agent response", activity: "", activityLogId: null,  });
  mockSendTelegramMessage.mockReset().mockResolvedValue(undefined);
  mockSendTelegramVoice.mockReset().mockResolvedValue(true);
  mockSendChatAction.mockReset().mockResolvedValue(undefined);
  mockTranscribeVoiceMessage.mockReset().mockResolvedValue("transcribed text");
  mockSynthesizeVoiceReply.mockReset().mockResolvedValue(Buffer.from("audio"));
  mockExtractTextFromImage.mockReset().mockResolvedValue("image text");
  mockExtractTextFromDocument.mockReset().mockResolvedValue("document text");
  mockSetMessageHandler.mockReset();
  mockProcessUpdate.mockReset();
  mockGetOuraSyncRun.mockReset().mockResolvedValue(null);
  mockGetActivityLog.mockReset().mockResolvedValue(null);
  mockIsPracticeSessionActive.mockReset().mockReturnValue(false);
  mockStartPracticeSession.mockReset().mockReturnValue({ sessionId: "abc123", startedAt: new Date() });
  mockEndPracticeSession.mockReset().mockReturnValue({ sessionId: "abc123", startedAt: new Date() });
  mockRunPracticeExtraction.mockReset().mockResolvedValue({
    diffSummary: "- No significant changes.",
    messageCount: 4,
    wrotePersisted: true,
  });
  mockBuildSpanishPracticeSystemPrompt.mockReset().mockResolvedValue("PRACTICE PROMPT");
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
        "used 3 memories (behavior, fact) | <a href=\"https://example.com/api/activity/9\">details</a>",
      activityLogId: 9,
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Done.\n\n<i>used 3 memories (behavior, fact)</i>",
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              text: "Details",
              callback_data: "activity_detail:9:3:0",
            }),
          ]),
        ]),
      })
    );
  });

  it("removes inline details link without adding button when no memory summary exists", async () => {
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

  it("ignores reaction messages entirely", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "", messageId: 5, date: 1000, reactionEmoji: "👍" });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockSendChatAction).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });
});

describe("typing heartbeat", () => {
  it("sends repeated typing indicators while agent is working", async () => {
    vi.useFakeTimers();
    try {
      let resolveAgent:
        | ((value: { response: string; activity: string }) => void)
        | undefined;
      mockRunAgent.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAgent = resolve;
          })
      );

      const handler = getHandler();
      const pending = handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

      // Advance past the typing heartbeat interval (4500ms)
      await vi.advanceTimersByTimeAsync(4700);
      expect(mockSendChatAction).toHaveBeenCalledWith("100", "typing");

      expect(resolveAgent).toBeDefined();
      if (!resolveAgent) {
        throw new Error("resolveAgent was not initialized");
      }
      resolveAgent({
        response: "agent response",
        activity: "",
      });
      await pending;
    } finally {
      vi.useRealTimers();
    }
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
      })
    );
  });

  it("handles /compact command with bot mention", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/compact@test_bot", messageId: 1, date: 1000 });

    expect(mockForceCompact).toHaveBeenCalledWith("100", expect.any(Function));
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});

describe("/practice command", () => {
  it("starts a practice session and sends a Spanish greeting", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/practice", messageId: 1, date: 1000 });

    expect(mockStartPracticeSession).toHaveBeenCalledWith("100");
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Sesión de práctica iniciada")
    );
  });

  it("refuses when a session is already active", async () => {
    mockIsPracticeSessionActive.mockReturnValueOnce(true);
    const handler = getHandler();
    await handler({ chatId: 100, text: "/practice", messageId: 1, date: 1000 });

    expect(mockStartPracticeSession).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Ya estamos en sesión")
    );
  });
});

describe("/done command", () => {
  it("ends the session and sends the extraction diff summary", async () => {
    const handler = getHandler();
    await handler({ chatId: 100, text: "/done", messageId: 1, date: 1000 });

    expect(mockEndPracticeSession).toHaveBeenCalledWith("100");
    expect(mockRunPracticeExtraction).toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Estado actualizado")
    );
  });

  it("reports when extraction could not persist", async () => {
    mockRunPracticeExtraction.mockResolvedValueOnce({
      diffSummary: "State file missing.",
      messageCount: 2,
      wrotePersisted: false,
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "/done", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("estado no guardado")
    );
  });

  it("responds when no session is active", async () => {
    mockEndPracticeSession.mockReturnValueOnce(null);
    const handler = getHandler();
    await handler({ chatId: 100, text: "/done", messageId: 1, date: 1000 });

    expect(mockRunPracticeExtraction).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("No hay sesión activa")
    );
  });

  it("reports extraction errors without crashing", async () => {
    mockRunPracticeExtraction.mockRejectedValueOnce(new Error("LLM down"));
    const handler = getHandler();
    await handler({ chatId: 100, text: "/done", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("Extraction failed: LLM down")
    );
  });
});

describe("active practice session routing", () => {
  it("passes the Spanish practice system prompt to runAgent when active", async () => {
    mockIsPracticeSessionActive.mockReturnValue(true);
    const handler = getHandler();
    await handler({ chatId: 100, text: "Hola, ¿cómo estás?", messageId: 1, date: 1000 });

    expect(mockBuildSpanishPracticeSystemPrompt).toHaveBeenCalled();
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptOverride: "PRACTICE PROMPT",
      })
    );
    // No activity line in practice mode
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });

  it("sends voice + text when input was voice and session is active", async () => {
    mockIsPracticeSessionActive.mockReturnValue(true);
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-xyz", durationSeconds: 4 },
    });

    expect(mockSynthesizeVoiceReply).toHaveBeenCalledWith("agent response");
    expect(mockSendTelegramVoice).toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });

  it("only sends text when input was text even if session is active", async () => {
    mockIsPracticeSessionActive.mockReturnValue(true);
    const handler = getHandler();
    await handler({ chatId: 100, text: "Hola", messageId: 1, date: 1000 });

    expect(mockSynthesizeVoiceReply).not.toHaveBeenCalled();
    expect(mockSendTelegramVoice).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
  });

  it("recovers when voice synthesis fails mid-session", async () => {
    mockIsPracticeSessionActive.mockReturnValue(true);
    mockSynthesizeVoiceReply.mockRejectedValueOnce(new Error("TTS down"));
    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "",
      messageId: 1,
      date: 1000,
      voice: { fileId: "voice-xyz", durationSeconds: 4 },
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("voice synth failed"),
      expect.any(Error)
    );
    // Text still goes through even when voice fails
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("100", "agent response");
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
      text: "activity_detail:9:3:0",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:9:3:0",
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
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns not found when activity log does not exist", async () => {
    mockGetActivityLog.mockResolvedValueOnce(null);

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:99:1:0",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:99:1:0",
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
      text: "activity_detail:abc:1:0",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:abc:1:0",
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
    expect(detail).not.toContain("Top memories:");
    expect(detail).not.toContain("Tools:");
  });

  it("handles activity detail callback errors gracefully", async () => {
    mockGetActivityLog.mockRejectedValueOnce(new Error("db down"));

    const handler = getHandler();
    await handler({
      chatId: 100,
      text: "activity_detail:9:1:0",
      messageId: 10,
      date: 1000,
      callbackData: "activity_detail:9:1:0",
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
