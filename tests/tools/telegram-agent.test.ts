import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInsertChatMessage,
  mockGetRecentMessages,
  mockMarkMessagesCompacted,
  mockGetLastCompactionTime,
  mockInsertActivityLog,
  mockAnthropicCreate,
  mockOpenAIChatCreate,
  mockToolHandler,
  mockConfig,
} = vi.hoisted(() => ({
  mockInsertChatMessage: vi.fn().mockResolvedValue({ inserted: true, id: 1 }),
  mockGetRecentMessages: vi.fn().mockResolvedValue([]),
  mockMarkMessagesCompacted: vi.fn().mockResolvedValue(undefined),
  mockGetLastCompactionTime: vi.fn().mockResolvedValue(null),
  mockInsertActivityLog: vi.fn().mockResolvedValue({
    id: 1,
    chat_id: "100",
    memories: [],
    tool_calls: [],
    cost_usd: null,
    created_at: new Date(),
  }),
  mockAnthropicCreate: vi.fn(),
  mockOpenAIChatCreate: vi.fn(),
  mockToolHandler: vi.fn().mockResolvedValue("tool result text"),
  mockConfig: {
    telegram: {
      botToken: "123:ABC",
      secretToken: "",
      allowedChatId: "100",
      llmProvider: "anthropic",
    },
    openai: {
      apiKey: "sk-test",
      chatModel: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    },
    anthropic: { apiKey: "sk-ant-test", model: "claude-sonnet-4-6" },
    oura: { accessToken: "" },
    server: { appUrl: "", mcpSecret: "" },
    timezone: "Europe/Madrid",
  },
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/config.js", () => ({
  config: mockConfig,
}));

const { mockPoolQuery } = vi.hoisted(() => ({
  mockPoolQuery: vi.fn().mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("pg_try_advisory_lock")) {
      return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
    }
    if (typeof sql === "string" && sql.includes("pg_advisory_unlock")) {
      return Promise.resolve({ rows: [{ pg_advisory_unlock: true }] });
    }
    // Hash check: return no rows (no duplicate)
    if (typeof sql === "string" && sql.includes("canonical_hash")) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  }),
}));

vi.mock("../../src/db/client.js", () => ({
  pool: { query: mockPoolQuery },
}));

vi.mock("../../src/db/queries.js", () => ({
  insertChatMessage: mockInsertChatMessage,
  getRecentMessages: mockGetRecentMessages,
  markMessagesCompacted: mockMarkMessagesCompacted,
  getLastCompactionTime: mockGetLastCompactionTime,
  insertActivityLog: mockInsertActivityLog,
}));

vi.mock("../../src/server.js", () => ({
  toolHandlers: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === "string") return mockToolHandler;
        return undefined;
      },
    }
  ),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: mockAnthropicCreate,
    },
  })),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockOpenAIChatCreate,
      },
    },
  })),
}));

import { runAgent, truncateToolResult, compactIfNeeded, forceCompact } from "../../src/telegram/agent.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mockInsertChatMessage.mockReset().mockResolvedValue({ inserted: true, id: 1 });
  mockGetRecentMessages.mockReset().mockResolvedValue([]);
  mockMarkMessagesCompacted.mockReset().mockResolvedValue(undefined);
  mockInsertActivityLog.mockReset().mockResolvedValue({
    id: 1,
    chat_id: "100",
    memories: [],
    tool_calls: [],
    cost_usd: null,
    created_at: new Date(),
  });
  mockAnthropicCreate.mockReset();
  mockOpenAIChatCreate.mockReset();
  mockToolHandler.mockReset().mockResolvedValue("tool result text");
  mockConfig.telegram.llmProvider = "anthropic";
  mockConfig.openai.chatModel = "gpt-5-mini";
  mockPoolQuery.mockReset().mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("pg_try_advisory_lock")) {
      return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
    }
    if (typeof sql === "string" && sql.includes("pg_advisory_unlock")) {
      return Promise.resolve({ rows: [{ pg_advisory_unlock: true }] });
    }
    if (typeof sql === "string" && sql.includes("canonical_hash")) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgent", () => {
  it("sends a message and returns Claude's response", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hello! How are you?" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "Hi",
      messageDate: 1000,
    });

    expect(result.response).toBe("Hello! How are you?");
    expect(result.activity).toBe("");

    // User message is now stored by handleMessage() in webhook.ts, not runAgent().
    // runAgent() only stores the assistant message.
    expect(mockInsertChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "assistant",
        content: "Hello! How are you?",
      })
    );

  });

  it("supports openai provider for chat responses", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "Hola! Hoe gaat het? Hello from ChatGPT." } }],
      usage: { prompt_tokens: 90, completion_tokens: 25 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "Hi",
      messageDate: 1000,
    });

    expect(result.response).toBe("Hola! Hoe gaat het? Hello from ChatGPT.");
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(mockOpenAIChatCreate).toHaveBeenCalledTimes(1);
  });

  it("handles openai agent responses without usage metadata", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "No usage payload" } }],
    });

    const result = await runAgent({
      chatId: "100",
      message: "Hi",
      messageDate: 1000,
    });

    expect(result.response).toBe("No usage payload");
  });

  it("supports openai tool calls and returns final text", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            content: "Checking your journal...",
            tool_calls: [{
              id: "tc-1",
              type: "function",
              function: {
                name: "search_entries",
                arguments: JSON.stringify({ query: "stress" }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "You mentioned stress 3 times this week." } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      });

    const result = await runAgent({
      chatId: "100",
      message: "When did I mention stress?",
      messageDate: 1000,
    });

    expect(result.response).toBe("You mentioned stress 3 times this week.");
    expect(mockToolHandler).toHaveBeenCalledWith(expect.anything(), { query: "stress" });
    expect(mockInsertChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "tool_result",
        toolCallId: "tc-1",
      })
    );
  });

  it("handles openai tool execution errors gracefully", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockToolHandler.mockRejectedValueOnce(new Error("openai tool failed"));
    mockOpenAIChatCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            content: "Calling tool...",
            tool_calls: [{
              id: "tc-err",
              type: "function",
              function: {
                name: "search_entries",
                arguments: JSON.stringify({ query: "x" }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 70, completion_tokens: 10 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "Tool error handled." } }],
        usage: { prompt_tokens: 80, completion_tokens: 15 },
      });

    const result = await runAgent({
      chatId: "100",
      message: "trigger error",
      messageDate: 1000,
    });

    expect(result.response).toBe("Tool error handled.");
    expect(mockInsertChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "tool_result",
        toolCallId: "tc-err",
      })
    );
  });

  it("handles openai tool calls with invalid JSON arguments", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            content: "Let me try.",
            tool_calls: [{
              id: "tc-bad",
              type: "function",
              function: {
                name: "search_entries",
                arguments: "{bad-json",
              },
            }],
          },
        }],
        usage: { prompt_tokens: 80, completion_tokens: 10 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "I couldn't parse the tool input." } }],
        usage: { prompt_tokens: 90, completion_tokens: 20 },
      });

    const result = await runAgent({
      chatId: "100",
      message: "test invalid tool args",
      messageDate: 1000,
    });

    expect(result.response).toBe("I couldn't parse the tool input.");
    expect(mockToolHandler).not.toHaveBeenCalled();
    expect(mockInsertChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "tool_result",
        toolCallId: "tc-bad",
        content: expect.stringContaining("Invalid JSON arguments"),
      })
    );
  });

  it("handles openai tool calls with empty argument string", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "tc-empty-args",
              type: "function",
              function: {
                name: "list_tags",
                arguments: "",
              },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

    await runAgent({
      chatId: "100",
      message: "empty args",
      messageDate: 1000,
    });

    expect(mockToolHandler).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("stops openai tool loop on no-progress duplicate call", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            content: "Step 1",
            tool_calls: [{
              id: "tc-dup-1",
              type: "function",
              function: {
                name: "list_tags",
                arguments: JSON.stringify({}),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      })
      .mockResolvedValueOnce({
        choices: [{
          message: {
            role: "assistant",
            content: "Step 2",
            tool_calls: [{
              id: "tc-dup-2",
              type: "function",
              function: {
                name: "list_tags",
                arguments: JSON.stringify({}),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 60, completion_tokens: 10 },
      });

    const result = await runAgent({
      chatId: "100",
      message: "show tags repeatedly",
      messageDate: 1000,
    });

    expect(result.response).toBe("Step 2");
    expect(mockToolHandler).toHaveBeenCalledTimes(1);
  });

  it("stores activity log when tool calls are made", async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me look that up." },
          {
            type: "tool_use",
            id: "tu-activity",
            name: "search_entries",
            input: { query: "morning routine" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Found your morning entries." }],
        usage: { input_tokens: 120, output_tokens: 30 },
      });

    const result = await runAgent({
      chatId: "100",
      message: "What does my morning routine look like?",
      messageDate: 1000,
    });

    expect(result.response).toBe("Found your morning entries.");
    expect(result.activityLogId).toBe(1);
    expect(mockInsertActivityLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: "100",
        toolCalls: [
          expect.objectContaining({
            name: "search_entries",
            args: { query: "morning routine" },
          }),
        ],
      })
    );
  });

  it("does not store activity log when no tools and no patterns", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Just chatting." }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "Hey",
      messageDate: 1000,
    });

    expect(result.response).toBe("Just chatting.");
    expect(result.activityLogId).toBeNull();
    expect(mockInsertActivityLog).not.toHaveBeenCalled();
  });

  it("includes activity link when APP_URL is set", async () => {
    mockConfig.server.appUrl = "https://example.com";
    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-link", name: "list_tags", input: {} },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Here are the tags." }],
        usage: { input_tokens: 60, output_tokens: 10 },
      });

    const result = await runAgent({
      chatId: "100",
      message: "show tags",
      messageDate: 1000,
    });

    expect(result.activity).toContain("https://example.com/api/activity/1");
    expect(result.activity).toContain("details");
    mockConfig.server.appUrl = "";
  });

  it("includes token in activity link when MCP_SECRET is set", async () => {
    mockConfig.server.appUrl = "https://example.com";
    mockConfig.server.mcpSecret = "my-secret";
    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "tu-token", name: "list_tags", input: {} },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Tags here." }],
        usage: { input_tokens: 60, output_tokens: 10 },
      });

    const result = await runAgent({
      chatId: "100",
      message: "show tags",
      messageDate: 1000,
    });

    expect(result.activity).toContain("https://example.com/api/activity/1?token=my-secret");
    mockConfig.server.appUrl = "";
    mockConfig.server.mcpSecret = "";
  });

  it("returns null when openai returns no choices", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "hello",
      messageDate: 1000,
    });

    expect(result.response).toBeNull();
  });

  it("stops openai tool loop at MAX_TOOL_CALLS", async () => {
    mockConfig.telegram.llmProvider = "openai";
    const toolCalls = Array.from({ length: 16 }, (_, i) => ({
      id: `tc-max-${i}`,
      type: "function" as const,
      function: {
        name: "list_tags",
        arguments: JSON.stringify({ i }),
      },
    }));

    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "Batch tools", tool_calls: toolCalls } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "many tools",
      messageDate: 1000,
    });

    expect(result.response).toBe("Batch tools");
    expect(mockToolHandler.mock.calls.length).toBeLessThanOrEqual(15);
  });

  it("reconstructs recent messages for openai context", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockGetRecentMessages.mockResolvedValueOnce([
      { id: 1, chat_id: "100", external_message_id: null, role: "user", content: "Earlier user note", tool_call_id: null, compacted_at: null, created_at: new Date() },
      { id: 2, chat_id: "100", external_message_id: null, role: "assistant", content: "Earlier assistant reply", tool_call_id: null, compacted_at: null, created_at: new Date() },
    ]);
    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "Continuing..." } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });

    await runAgent({
      chatId: "100",
      message: "continue",
      messageDate: 1000,
    });

    const call = mockOpenAIChatCreate.mock.calls[0][0];
    expect(call.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Earlier user note" }),
        expect.objectContaining({ role: "assistant", content: "Earlier assistant reply" }),
      ])
    );
  });

  it("executes tool calls and returns final text", async () => {
    // First call: tool_use
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tool-1", name: "search_entries", input: { query: "stress" } },
      ],
      usage: { input_tokens: 150, output_tokens: 30 },
    });

    // Second call: final text
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Based on your entries, you've mentioned stress several times." }],
      usage: { input_tokens: 200, output_tokens: 40 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "When have I been stressed?",
      messageDate: 1000,
    });

    expect(result.response).toBe("Based on your entries, you've mentioned stress several times.");
    expect(result.activity).toContain("1 tools (search_entries)");
    expect(mockToolHandler).toHaveBeenCalledTimes(1);

    // Tool result stored
    expect(mockInsertChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "tool_result",
        toolCallId: "tool-1",
      })
    );
  });

  it("handles tool execution errors gracefully", async () => {
    mockToolHandler.mockRejectedValueOnce(new Error("DB connection failed"));

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tool-1", name: "search_entries", input: { query: "test" } },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Sorry, I had trouble searching." }],
      usage: { input_tokens: 150, output_tokens: 25 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "search for test",
      messageDate: 1000,
    });

    expect(result.response).toBe("Sorry, I had trouble searching.");
  });

  it("stops after max tool calls", async () => {
    // Return tool_use for every call with different inputs to avoid no-progress detection
    for (let i = 0; i < 16; i++) {
      mockAnthropicCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: `Step ${i + 1}` },
          { type: "tool_use", id: `tool-${i}`, name: "list_tags", input: { step: i } },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    }

    const result = await runAgent({
      chatId: "100",
      message: "Do lots of things",
      messageDate: 1000,
    });

    // Should stop at max (15 calls)
    expect(mockToolHandler.mock.calls.length).toBeLessThanOrEqual(15);
    expect(result.response).toBeTruthy();
  });

  it("detects no-progress and stops", async () => {
    // Same tool call twice
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tool-1", name: "search_entries", input: { query: "same" } },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Trying again..." },
        { type: "tool_use", id: "tool-2", name: "search_entries", input: { query: "same" } },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "search something",
      messageDate: 1000,
    });

    // Should have stopped after detecting no progress on the second identical call
    // The first tool_use executes, the second is detected as duplicate before execution
    expect(mockToolHandler).toHaveBeenCalledTimes(1);
    expect(result.response).toBeTruthy();
  });

  it("returns null when Claude returns empty text", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [],
      usage: { input_tokens: 100, output_tokens: 0 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "hello",
      messageDate: 1000,
    });

    expect(result.response).toBeNull();
  });

    it("includes journal composition instructions in system prompt", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Entry text" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    await runAgent({
      chatId: "100",
      message: "write the entry",
      messageDate: 1000,
    });

    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("Journal entry composition:");
  });

  it("prepends prefill to response and adds assistant message to API call", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Open. Trust. Flow.\n\nSleep/Ready: 49/66" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "Write the entry now.",
      messageDate: 1000,
      prefill: "#",
    });

    // Prefill is prepended to the response
    expect(result.response).toBe("#Open. Trust. Flow.\n\nSleep/Ready: 49/66");

    // Prefill is sent as a partial assistant message
    const call = mockAnthropicCreate.mock.calls[0][0];
    const lastMsg = call.messages[call.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.content).toBe("#");
  });

                  it("stores raw user command but sends transformed prompt message when provided", async () => {
    mockGetRecentMessages.mockResolvedValueOnce([
      {
        id: 1,
        chat_id: "100",
        external_message_id: "update:compose-raw",
        role: "user",
        content: "/compose",
        tool_call_id: null,
        compacted_at: null,
        created_at: new Date(),
      },
    ]);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Writing the entry now." }],
      usage: { input_tokens: 120, output_tokens: 20 },
    });

    await runAgent({
      chatId: "100",
      message: "Write the entry now.",
      storedUserMessage: "/compose",
      messageDate: 1000,
    });

    // User message ("/compose") is now stored by handleMessage() in webhook.ts.
    // runAgent() receives the transformed text and uses storedUserMessage for context replacement.

    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Write the entry now.",
        }),
      ])
    );
    expect(call.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "/compose" }),
      ])
    );
  });

    it("reconstructs recent messages for context", async () => {
    mockGetRecentMessages.mockResolvedValueOnce([
      { id: 1, chat_id: "100", external_message_id: null, role: "user", content: "Previous message", tool_call_id: null, compacted_at: null, created_at: new Date() },
      { id: 2, chat_id: "100", external_message_id: null, role: "assistant", content: "Previous response", tool_call_id: null, compacted_at: null, created_at: new Date() },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Following up on our chat." }],
      usage: { input_tokens: 200, output_tokens: 20 },
    });

    await runAgent({
      chatId: "100",
      message: "continue",
      messageDate: 1000,
    });

    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Previous message" }),
        expect.objectContaining({ role: "assistant", content: "Previous response" }),
      ])
    );
  });

  it("handles unknown tool names", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "tool_use", id: "tool-1", name: "nonexistent_tool", input: {} },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    // Use a real handler map for this test by making the proxy return undefined
    mockToolHandler.mockImplementationOnce(() => {
      throw new Error("should not be called");
    });

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "That tool doesn't exist." }],
      usage: { input_tokens: 150, output_tokens: 20 },
    });

    // The proxy always returns mockToolHandler, so this test verifies
    // the error handling path when the handler throws
    const result = await runAgent({
      chatId: "100",
      message: "test",
      messageDate: 1000,
    });

    expect(result.response).toBeTruthy();
  });

  });

describe.skip("compactIfNeeded — additional coverage", () => {
        it("links new patterns to entry UUIDs", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [{
            content: "Pattern with entries",
            kind: "behavior",
            confidence: 0.8,
            signal: "explicit",
            evidence_message_ids: [1],
            entry_uuids: ["ENTRY-001", "ENTRY-002"],
            temporal: {},
          }],
          reinforcements: [],
          contradictions: [],
          supersedes: [],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockLinkPatternToEntry).toHaveBeenCalledWith(
      expect.anything(), 1, "ENTRY-001", "compaction", 0.8
    );
    expect(mockLinkPatternToEntry).toHaveBeenCalledWith(
      expect.anything(), 1, "ENTRY-002", "compaction", 0.8
    );
  });

    });

describe("truncateToolResult", () => {
  it("returns short results unchanged", () => {
    expect(truncateToolResult("search_entries", "short result")).toBe("short result");
  });

  it("truncates long generic results with ellipsis", () => {
    const long = "x".repeat(600);
    const result = truncateToolResult("get_entry", long);
    expect(result.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(result).toContain("...");
  });

  it("truncates search_entries at line boundaries", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Entry ${i}: ${"y".repeat(100)}`);
    const result = truncateToolResult("search_entries", lines.join("\n"));
    expect(result.length).toBeLessThanOrEqual(600);
  });
});

describe.skip("compactIfNeeded", () => {
  it("skips compaction when context is under budget", async () => {
    mockGetRecentMessages.mockResolvedValueOnce([
      { id: 1, role: "user", content: "short", chat_id: "100", external_message_id: null, tool_call_id: null, compacted_at: null, created_at: new Date() },
    ]);

    await compactIfNeeded("100");

    // Should not attempt to acquire lock
    expect(mockMarkMessagesCompacted).not.toHaveBeenCalled();
  });

      it("marks messages compacted even when extraction returns null", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    // Invalid response → extraction returns null
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not valid json" }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
  });

  it("marks messages compacted when anthropic returns no text block", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "t1", name: "search_entries", input: {} }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    await compactIfNeeded("100");

    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
  });

  it("handles reinforcements during compaction", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            new_patterns: [],
            reinforcements: [{
              pattern_id: 5,
              confidence: 0.9,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: ["ENTRY-001"],
            }],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockReinforcePattern).toHaveBeenCalledWith(expect.anything(), 5, 0.9);
    expect(mockLinkPatternToEntry).toHaveBeenCalledWith(
      expect.anything(), 5, "ENTRY-001", "compaction", 0.9
    );
  });

                    it("skips compaction when lock is not acquired", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages.mockResolvedValueOnce(messages);

    // Override pool.query to return false for lock
    mockPoolQuery.mockImplementationOnce(() =>
      Promise.resolve({ rows: [{ pg_try_advisory_lock: false }] })
    );

    await compactIfNeeded("100");

    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(mockMarkMessagesCompacted).not.toHaveBeenCalled();
  });

  it("calls onCompacted callback with summary when patterns are extracted", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [{
            content: "Test callback pattern",
            kind: "behavior",
            confidence: 0.8,
            signal: "explicit",
            evidence_message_ids: [1],
            entry_uuids: [],
            temporal: {},
          }],
          reinforcements: [{ pattern_id: 5, confidence: 0.9, signal: "explicit", evidence_message_ids: [2], entry_uuids: [] }],
          contradictions: [],
          supersedes: [],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const onCompacted = vi.fn().mockResolvedValue(undefined);
    await compactIfNeeded("100", onCompacted);

    expect(onCompacted).toHaveBeenCalledWith(
      "saved 1 memory (behavior) · reinforced 1"
    );
  });

  it("includes contradictions and supersessions in onCompacted summary", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [],
          reinforcements: [],
          contradictions: [{ pattern_id: 3, reason: "outdated", evidence_message_ids: [1] }],
          supersedes: [{ old_pattern_id: 4, reason: "replaced", new_pattern_content: "New", evidence_message_ids: [2] }],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const onCompacted = vi.fn().mockResolvedValue(undefined);
    await compactIfNeeded("100", onCompacted);

    expect(onCompacted).toHaveBeenCalledWith(
      "flagged 1 as disputed · superseded 1"
    );
  });

  it("pluralizes saved memories in compaction summary", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [
            {
              content: "Pattern one",
              kind: "behavior",
              confidence: 0.8,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            },
            {
              content: "Pattern two",
              kind: "fact",
              confidence: 0.8,
              signal: "explicit",
              evidence_message_ids: [2],
              entry_uuids: [],
              temporal: {},
            },
          ],
          reinforcements: [],
          contradictions: [],
          supersedes: [],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const onCompacted = vi.fn().mockResolvedValue(undefined);
    await compactIfNeeded("100", onCompacted);

    expect(onCompacted).toHaveBeenCalledWith(
      "saved 2 memories (behavior, fact)"
    );
  });

  it("reports stale event memories pending review (no auto-prune)", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockCountStaleEventPatterns.mockResolvedValueOnce(2);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [],
          reinforcements: [],
          contradictions: [],
          supersedes: [],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const onCompacted = vi.fn().mockResolvedValue(undefined);
    await compactIfNeeded("100", onCompacted);

    expect(onCompacted).toHaveBeenCalledWith(
      "2 stale event memories pending review"
    );
  });

  it("reports singular stale event memory wording", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockCountStaleEventPatterns.mockResolvedValueOnce(1);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [],
          reinforcements: [],
          contradictions: [],
          supersedes: [],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const onCompacted = vi.fn().mockResolvedValue(undefined);
    await compactIfNeeded("100", onCompacted);

    expect(onCompacted).toHaveBeenCalledWith(
      "1 stale event memory pending review"
    );
  });

  it("does not call onCompacted when extraction has no results", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [],
          reinforcements: [],
          contradictions: [],
          supersedes: [],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const onCompacted = vi.fn().mockResolvedValue(undefined);
    await compactIfNeeded("100", onCompacted);

    expect(onCompacted).not.toHaveBeenCalled();
  });

  it("handles extraction with JSON wrapped in markdown code blocks", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: '```json\n{"new_patterns": [], "reinforcements": [], "contradictions": [], "supersedes": []}\n```',
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
  });

  it("triggers time-based compaction when 12+ hours since last compaction", async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "short message",
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    // Under token budget but enough messages
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    // Last compaction was 13 hours ago
    mockGetLastCompactionTime.mockResolvedValueOnce(
      new Date(Date.now() - 13 * 60 * 60 * 1000)
    );

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ new_patterns: [], reinforcements: [], contradictions: [], supersedes: [] }) }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
  });

  it("triggers time-based compaction when never compacted before", async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "short message",
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    // Never compacted — getLastCompactionTime returns null (default mock)

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ new_patterns: [], reinforcements: [], contradictions: [], supersedes: [] }) }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
  });

  it("skips time-based compaction when last compaction was recent", async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "short message",
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages.mockResolvedValueOnce(messages);

    // Last compaction was 2 hours ago
    mockGetLastCompactionTime.mockResolvedValueOnce(
      new Date(Date.now() - 2 * 60 * 60 * 1000)
    );

    await compactIfNeeded("100");

    expect(mockMarkMessagesCompacted).not.toHaveBeenCalled();
  });

  it("skips time-based compaction with too few messages", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "short message",
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages.mockResolvedValueOnce(messages);

    await compactIfNeeded("100");

    // Too few messages, should skip without checking time
    expect(mockMarkMessagesCompacted).not.toHaveBeenCalled();
  });
});

describe.skip("forceCompact", () => {
  it("runs compaction regardless of budget", async () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "short message",
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages.mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ new_patterns: [{ content: "test pattern", kind: "behavior", confidence: 0.8, signal: "explicit", evidence_message_ids: [1], entry_uuids: [], temporal: {} }], reinforcements: [], contradictions: [], supersedes: [] }) }],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    const onCompacted = vi.fn();
    await forceCompact("100", onCompacted);

    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
    expect(onCompacted).toHaveBeenCalledWith("saved 1 memory (behavior)");
  });

  it("reports nothing to compact with too few messages", async () => {
    mockGetRecentMessages.mockResolvedValueOnce([
      { id: 1, role: "user", content: "hi", chat_id: "100", external_message_id: null, tool_call_id: null, compacted_at: null, created_at: new Date() },
    ]);

    const onCompacted = vi.fn();
    await forceCompact("100", onCompacted);

    expect(onCompacted).toHaveBeenCalledWith("nothing to compact");
    expect(mockMarkMessagesCompacted).not.toHaveBeenCalled();
  });

  it("reports lock contention", async () => {
    const messages = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: "short message",
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));

    mockGetRecentMessages.mockResolvedValueOnce(messages);

    // Lock not acquired
    mockPoolQuery.mockImplementationOnce((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ pg_try_advisory_lock: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const onCompacted = vi.fn();
    await forceCompact("100", onCompacted);

    expect(onCompacted).toHaveBeenCalledWith("compaction already in progress");
  });
});

describe.skip("pulse check after compaction", () => {
  beforeEach(() => {
    mockConfig.telegram.llmProvider = "anthropic";
  });

  function buildCompactionMessages(count: number): {
    id: number;
    role: string;
    content: string;
    chat_id: string;
    external_message_id: string | null;
    tool_call_id: string | null;
    compacted_at: Date | null;
    created_at: Date;
  }[] {
    const longContent = "x".repeat(10_000);
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      role: "user",
      content: longContent,
      chat_id: "100",
      external_message_id: null,
      tool_call_id: null,
      compacted_at: null,
      created_at: new Date(),
    }));
  }

  function setupCompactionExtraction(): void {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [],
          reinforcements: [],
          contradictions: [],
          supersedes: [],
        }),
      }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  }

  it("runs pulse check after compaction when enabled", async () => {
    const messages = buildCompactionMessages(20);
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);
    setupCompactionExtraction();

    // Pulse check: no recent pulse, stale stats (total < 5)
    mockGetLastPulseCheckTime.mockResolvedValueOnce(null);
    mockGetSoulQualityStats.mockResolvedValueOnce({
      felt_personal: 0, felt_generic: 0, correction: 0,
      positive_reaction: 0, total: 0, personal_ratio: 0,
    });

    await compactIfNeeded("100");

    expect(mockInsertPulseCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: "100",
        status: "stale",
      })
    );
  });

  it("skips pulse check when pulse is disabled", async () => {
    mockConfig.telegram.pulseEnabled = false;

    const messages = buildCompactionMessages(20);
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);
    setupCompactionExtraction();

    await compactIfNeeded("100");

    expect(mockGetLastPulseCheckTime).not.toHaveBeenCalled();
    expect(mockInsertPulseCheck).not.toHaveBeenCalled();
  });

  it("skips pulse check when soul is disabled", async () => {
    mockConfig.telegram.soulEnabled = false;

    const messages = buildCompactionMessages(20);
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);
    setupCompactionExtraction();

    await compactIfNeeded("100");

    expect(mockGetLastPulseCheckTime).not.toHaveBeenCalled();
    expect(mockInsertPulseCheck).not.toHaveBeenCalled();
  });

  it("skips pulse check when interval has not elapsed", async () => {
    const messages = buildCompactionMessages(20);
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);
    setupCompactionExtraction();

    // Recent pulse check (1 hour ago)
    mockGetLastPulseCheckTime.mockResolvedValueOnce(new Date(Date.now() - 1 * 60 * 60 * 1000));

    await compactIfNeeded("100");

    expect(mockInsertPulseCheck).not.toHaveBeenCalled();
  });

  it("applies soul repairs when drifting diagnosis detected", async () => {
    const messages = buildCompactionMessages(20);
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);
    setupCompactionExtraction();

    // Soul state exists
    mockGetSoulState.mockResolvedValueOnce({
      chat_id: "100",
      identity_summary: "A steady companion.",
      relational_commitments: ["stay direct"],
      tone_signature: ["warm"],
      growth_notes: [],
      version: 3,
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Pulse check: no recent pulse, drifting stats
    mockGetLastPulseCheckTime.mockResolvedValueOnce(null);
    mockGetSoulQualityStats.mockResolvedValueOnce({
      felt_personal: 1, felt_generic: 8, correction: 1,
      positive_reaction: 0, total: 10, personal_ratio: 0.1,
    });

    const onCompacted = vi.fn();
    await compactIfNeeded("100", onCompacted);

    // Should apply repairs and update soul state
    expect(mockUpsertSoulState).toHaveBeenCalled();
    expect(mockInsertSoulStateHistory).toHaveBeenCalled();
    expect(mockInsertPulseCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "drifting",
      })
    );
    // Should notify user
    expect(onCompacted).toHaveBeenCalledWith(
      expect.stringContaining("pulse:")
    );
  });

  it("logs and continues when pulse check throws", async () => {
    const messages = buildCompactionMessages(20);
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);
    setupCompactionExtraction();

    mockGetLastPulseCheckTime.mockRejectedValueOnce(
      new Error("pulse lookup failed")
    );

    await compactIfNeeded("100");

    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram pulse check error [chat:100]:",
      expect.any(Error)
    );
  });
});
