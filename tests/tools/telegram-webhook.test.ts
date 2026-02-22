import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockRunAgent, mockForceCompact, mockSendTelegramMessage, mockSendChatAction, mockTranscribeVoiceMessage, mockSetMessageHandler, mockProcessUpdate } = vi.hoisted(() => ({
  mockRunAgent: vi.fn().mockResolvedValue({ response: "agent response", activity: "" }),
  mockForceCompact: vi.fn().mockResolvedValue(undefined),
  mockSendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  mockSendChatAction: vi.fn().mockResolvedValue(undefined),
  mockTranscribeVoiceMessage: vi.fn().mockResolvedValue("transcribed text"),
  mockSetMessageHandler: vi.fn(),
  mockProcessUpdate: vi.fn(),
}));

vi.mock("../../src/telegram/agent.js", () => ({
  runAgent: mockRunAgent,
  forceCompact: mockForceCompact,
}));

vi.mock("../../src/telegram/client.js", () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  sendChatAction: mockSendChatAction,
}));

vi.mock("../../src/telegram/voice.js", () => ({
  transcribeVoiceMessage: mockTranscribeVoiceMessage,
}));

vi.mock("../../src/telegram/updates.js", () => ({
  setMessageHandler: mockSetMessageHandler,
  processUpdate: mockProcessUpdate,
}));

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: {
      botToken: "test-bot-token",
      secretToken: "test-secret",
      allowedChatId: "100",
    },
  },
}));

import { registerTelegramRoutes } from "../../src/telegram/webhook.js";

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
  mockRunAgent.mockReset().mockResolvedValue({ response: "agent response", activity: "" });
  mockSendTelegramMessage.mockReset().mockResolvedValue(undefined);
  mockSendChatAction.mockReset().mockResolvedValue(undefined);
  mockTranscribeVoiceMessage.mockReset().mockResolvedValue("transcribed text");
  mockSetMessageHandler.mockReset();
  mockProcessUpdate.mockReset();
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
      activity: "3 patterns | 2 tools (search_entries, get_entry)",
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "hello", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "Found it!\n\n<i>3 patterns | 2 tools (search_entries, get_entry)</i>"
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
      await onCompacted("2 new patterns, 1 reinforced");
    });

    const handler = getHandler();
    await handler({ chatId: 100, text: "/compact", messageId: 1, date: 1000 });

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "100",
      "<i>2 new patterns, 1 reinforced</i>"
    );
  });
});
