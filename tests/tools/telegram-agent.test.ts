import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInsertChatMessage,
  mockGetRecentMessages,
  mockSearchPatterns,
  mockGetTopPatterns,
  mockGetSoulState,
  mockUpsertSoulState,
  mockInsertPattern,
  mockReinforcePattern,
  mockInsertPatternAlias,
  mockInsertPatternObservation,
  mockLinkPatternToEntry,
  mockUpdatePatternStatus,
  mockMarkMessagesCompacted,
  mockLogApiUsage,
  mockLogMemoryRetrieval,
  mockGetLastCostNotificationTime,
  mockGetTotalApiCostSince,
  mockInsertCostNotification,
  mockFindSimilarPatterns,
  mockGetLastCompactionTime,
  mockCountStaleEventPatterns,
  mockInsertSoulQualitySignal,
  mockGetSoulQualityStats,
  mockInsertPulseCheck,
  mockGetLastPulseCheckTime,
  mockInsertSoulStateHistory,
  mockGenerateEmbedding,
  mockAnthropicCreate,
  mockOpenAIChatCreate,
  mockToolHandler,
  mockConfig,
} = vi.hoisted(() => ({
  mockInsertChatMessage: vi.fn().mockResolvedValue({ inserted: true, id: 1 }),
  mockGetRecentMessages: vi.fn().mockResolvedValue([]),
  mockSearchPatterns: vi.fn().mockResolvedValue([]),
  mockGetTopPatterns: vi.fn().mockResolvedValue([]),
  mockGetSoulState: vi.fn().mockResolvedValue(null),
  mockUpsertSoulState: vi.fn().mockResolvedValue({
    chat_id: "100",
    identity_summary: "A steady companion.",
    relational_commitments: ["stay direct"],
    tone_signature: ["warm", "direct"],
    growth_notes: ["initialized soul state from early conversation"],
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
  }),
  mockInsertPattern: vi.fn().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 1, times_seen: 1, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() }),
  mockReinforcePattern: vi.fn().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 2, times_seen: 2, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() }),
  mockInsertPatternAlias: vi.fn().mockResolvedValue(undefined),
  mockInsertPatternObservation: vi.fn().mockResolvedValue(1),
  mockLinkPatternToEntry: vi.fn().mockResolvedValue(undefined),
  mockUpdatePatternStatus: vi.fn().mockResolvedValue(undefined),
  mockMarkMessagesCompacted: vi.fn().mockResolvedValue(undefined),
  mockLogApiUsage: vi.fn().mockResolvedValue(undefined),
  mockLogMemoryRetrieval: vi.fn().mockResolvedValue(undefined),
  mockGetLastCostNotificationTime: vi.fn().mockResolvedValue(null),
  mockGetTotalApiCostSince: vi.fn().mockResolvedValue(0),
  mockInsertCostNotification: vi.fn().mockResolvedValue({
    id: 1,
    chat_id: "100",
    window_start: new Date(),
    window_end: new Date(),
    cost_usd: 0.05,
    created_at: new Date(),
  }),
  mockFindSimilarPatterns: vi.fn().mockResolvedValue([]),
  mockGetLastCompactionTime: vi.fn().mockResolvedValue(null),
  mockCountStaleEventPatterns: vi.fn().mockResolvedValue(0),
  mockInsertSoulQualitySignal: vi.fn().mockResolvedValue({
    id: 1,
    chat_id: "100",
    assistant_message_id: null,
    signal_type: "correction",
    soul_version: 1,
    pattern_count: 0,
    metadata: {},
    created_at: new Date(),
  }),
  mockGetSoulQualityStats: vi.fn().mockResolvedValue({
    felt_personal: 0,
    felt_generic: 0,
    correction: 0,
    positive_reaction: 0,
    total: 0,
    personal_ratio: 0,
  }),
  mockInsertPulseCheck: vi.fn().mockResolvedValue({
    id: 1, chat_id: "100", status: "stale", personal_ratio: 0,
    correction_rate: 0, signal_counts: {}, repairs_applied: [],
    soul_version_before: 0, soul_version_after: 0, created_at: new Date(),
  }),
  mockGetLastPulseCheckTime: vi.fn().mockResolvedValue(null),
  mockInsertSoulStateHistory: vi.fn().mockResolvedValue({
    id: 1, chat_id: "100", version: 1, identity_summary: "",
    relational_commitments: [], tone_signature: [], growth_notes: [],
    change_reason: "", created_at: new Date(),
  }),
  mockGenerateEmbedding: vi.fn().mockResolvedValue({
    embedding: new Array(1536).fill(0),
    inputTokens: 100,
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
      soulEnabled: true,
      pulseEnabled: true,
      pulseIntervalHours: 24,
    },
    openai: {
      apiKey: "sk-test",
      chatModel: "gpt-5-mini",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    },
    anthropic: { apiKey: "sk-ant-test", model: "claude-sonnet-4-6" },
    timezone: "Europe/Madrid",
    apiRates: {
      "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
      "text-embedding-3-small": { input: 0.02, output: 0 },
    } as Record<string, { input: number; output: number }>,
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
  searchPatterns: mockSearchPatterns,
  getTopPatterns: mockGetTopPatterns,
  getSoulState: mockGetSoulState,
  upsertSoulState: mockUpsertSoulState,
  insertPattern: mockInsertPattern,
  reinforcePattern: mockReinforcePattern,
  insertPatternAlias: mockInsertPatternAlias,
  insertPatternObservation: mockInsertPatternObservation,
  linkPatternToEntry: mockLinkPatternToEntry,
  updatePatternStatus: mockUpdatePatternStatus,
  markMessagesCompacted: mockMarkMessagesCompacted,
  logApiUsage: mockLogApiUsage,
  logMemoryRetrieval: mockLogMemoryRetrieval,
  getLastCostNotificationTime: mockGetLastCostNotificationTime,
  getTotalApiCostSince: mockGetTotalApiCostSince,
  insertCostNotification: mockInsertCostNotification,
  findSimilarPatterns: mockFindSimilarPatterns,
  getLastCompactionTime: mockGetLastCompactionTime,
  countStaleEventPatterns: mockCountStaleEventPatterns,
  insertSoulQualitySignal: mockInsertSoulQualitySignal,
  getSoulQualityStats: mockGetSoulQualityStats,
  insertPulseCheck: mockInsertPulseCheck,
  getLastPulseCheckTime: mockGetLastPulseCheckTime,
  insertSoulStateHistory: mockInsertSoulStateHistory,
}));

vi.mock("../../src/db/embeddings.js", () => ({
  generateEmbedding: vi.fn(async (...args: unknown[]) => {
    const result = await mockGenerateEmbedding(...args);
    return result.embedding;
  }),
  generateEmbeddingWithUsage: mockGenerateEmbedding,
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
  mockSearchPatterns.mockReset().mockResolvedValue([]);
  mockGetTopPatterns.mockReset().mockResolvedValue([]);
  mockGetSoulState.mockReset().mockResolvedValue(null);
  mockUpsertSoulState.mockReset().mockResolvedValue({
    chat_id: "100",
    identity_summary: "A steady companion.",
    relational_commitments: ["stay direct"],
    tone_signature: ["warm", "direct"],
    growth_notes: ["initialized soul state from early conversation"],
    version: 1,
    created_at: new Date(),
    updated_at: new Date(),
  });
  mockInsertPattern.mockReset().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 1, times_seen: 1, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() });
  mockReinforcePattern.mockReset().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 2, times_seen: 2, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() });
  mockInsertPatternAlias.mockReset().mockResolvedValue(undefined);
  mockInsertPatternObservation.mockReset().mockResolvedValue(1);
  mockLinkPatternToEntry.mockReset().mockResolvedValue(undefined);
  mockUpdatePatternStatus.mockReset().mockResolvedValue(undefined);
  mockMarkMessagesCompacted.mockReset().mockResolvedValue(undefined);
  mockLogApiUsage.mockReset().mockResolvedValue(undefined);
  mockLogMemoryRetrieval.mockReset().mockResolvedValue(undefined);
  mockGetLastCostNotificationTime.mockReset().mockResolvedValue(null);
  mockGetTotalApiCostSince.mockReset().mockResolvedValue(0);
  mockInsertCostNotification.mockReset().mockResolvedValue({
    id: 1,
    chat_id: "100",
    window_start: new Date(),
    window_end: new Date(),
    cost_usd: 0.05,
    created_at: new Date(),
  });
  mockFindSimilarPatterns.mockReset().mockResolvedValue([]);
  mockCountStaleEventPatterns.mockReset().mockResolvedValue(0);
  mockInsertSoulQualitySignal.mockReset().mockResolvedValue({
    id: 1,
    chat_id: "100",
    assistant_message_id: null,
    signal_type: "correction",
    soul_version: 1,
    pattern_count: 0,
    metadata: {},
    created_at: new Date(),
  });
  mockGetSoulQualityStats.mockReset().mockResolvedValue({
    felt_personal: 0,
    felt_generic: 0,
    correction: 0,
    positive_reaction: 0,
    total: 0,
    personal_ratio: 0,
  });
  mockInsertPulseCheck.mockReset().mockResolvedValue({
    id: 1, chat_id: "100", status: "stale", personal_ratio: 0,
    correction_rate: 0, signal_counts: {}, repairs_applied: [],
    soul_version_before: 0, soul_version_after: 0, created_at: new Date(),
  });
  mockGetLastPulseCheckTime.mockReset().mockResolvedValue(null);
  mockInsertSoulStateHistory.mockReset().mockResolvedValue({
    id: 1, chat_id: "100", version: 1, identity_summary: "",
    relational_commitments: [], tone_signature: [], growth_notes: [],
    change_reason: "", created_at: new Date(),
  });
  mockGenerateEmbedding.mockReset().mockResolvedValue({
    embedding: new Array(1536).fill(0),
    inputTokens: 100,
  });
  mockAnthropicCreate.mockReset();
  mockOpenAIChatCreate.mockReset();
  mockToolHandler.mockReset().mockResolvedValue("tool result text");
  mockConfig.telegram.llmProvider = "anthropic";
  mockConfig.telegram.soulEnabled = true;
  mockConfig.telegram.pulseEnabled = true;
  mockConfig.telegram.pulseIntervalHours = 24;
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
      externalMessageId: "update:1",
      messageDate: 1000,
    });

    expect(result.response).toBe("Hello! How are you?");
    expect(result.activity).toBe("");

    // Stores user message
    expect(mockInsertChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "user",
        content: "Hi",
        externalMessageId: "update:1",
      })
    );

    // Stores assistant message
    expect(mockInsertChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "assistant",
        content: "Hello! How are you?",
      })
    );

    expect(mockUpsertSoulState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: "100",
        version: 1,
      })
    );

    // Logs API usage
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "anthropic",
        purpose: "agent",
        inputTokens: 100,
        outputTokens: 20,
      })
    );
    // Short messages skip pattern retrieval and logging
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockLogMemoryRetrieval).not.toHaveBeenCalled();
  });

  it("supports openai provider for chat responses", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "Hello from ChatGPT" } }],
      usage: { prompt_tokens: 90, completion_tokens: 25 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "Hi",
      externalMessageId: "update:1b",
      messageDate: 1000,
    });

    expect(result.response).toBe("Hello from ChatGPT");
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(mockOpenAIChatCreate).toHaveBeenCalledTimes(1);
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5-mini",
        purpose: "agent",
        inputTokens: 90,
        outputTokens: 25,
      })
    );
  });

  it("adds a 12-hour throttled cost note when accrued cost is available", async () => {
    mockGetLastCostNotificationTime.mockResolvedValueOnce(
      new Date(Date.now() - 13 * 60 * 60 * 1000)
    );
    mockGetTotalApiCostSince.mockResolvedValueOnce(0.127);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Quick reply." }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "status?",
      externalMessageId: "update:cost-1",
      messageDate: 1000,
    });

    expect(result.response).toBe("Quick reply.");
    expect(result.activity).toContain("cost ~$0.13 since last note");
    expect(mockInsertCostNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        chatId: "100",
        costUsd: 0.127,
      })
    );
  });

  it("does not add cost note when the last notification is within the throttle window", async () => {
    mockGetLastCostNotificationTime.mockResolvedValueOnce(
      new Date(Date.now() - 60 * 60 * 1000)
    );
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "No new cost note." }],
      usage: { input_tokens: 90, output_tokens: 12 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "quick ping",
      externalMessageId: "update:cost-throttle",
      messageDate: 1000,
    });

    expect(result.response).toBe("No new cost note.");
    expect(result.activity).not.toContain("cost ~$");
    expect(mockGetTotalApiCostSince).not.toHaveBeenCalled();
    expect(mockInsertCostNotification).not.toHaveBeenCalled();
  });

  it("formats low accrued cost with three decimals in activity note", async () => {
    mockGetLastCostNotificationTime.mockResolvedValueOnce(
      new Date(Date.now() - 13 * 60 * 60 * 1000)
    );
    mockGetTotalApiCostSince.mockResolvedValueOnce(0.056);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Cost note format check." }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "status?",
      externalMessageId: "update:cost-2",
      messageDate: 1000,
    });

    expect(result.response).toBe("Cost note format check.");
    expect(result.activity).toContain("cost ~$0.056 since last note");
  });

  it("uses last 12h wording when no prior cost notification exists", async () => {
    mockGetLastCostNotificationTime.mockResolvedValueOnce(null);
    mockGetTotalApiCostSince.mockResolvedValueOnce(0.2);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Initial cost note." }],
      usage: { input_tokens: 90, output_tokens: 12 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "status?",
      externalMessageId: "update:cost-first",
      messageDate: 1000,
    });

    expect(result.response).toBe("Initial cost note.");
    expect(result.activity).toContain("cost ~$0.20 since last 12h");
  });

  it("adds soul quality ratio to activity when enough feedback signals exist", async () => {
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
    mockGetSoulQualityStats.mockResolvedValueOnce({
      felt_personal: 4,
      felt_generic: 2,
      correction: 1,
      positive_reaction: 1,
      total: 8,
      personal_ratio: 0.71,
    });
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Noted." }],
      usage: { input_tokens: 60, output_tokens: 12 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "quick update",
      externalMessageId: "update:soul-activity",
      messageDate: 1000,
    });

    expect(result.response).toBe("Noted.");
    expect(result.activity).toContain("soul v3 (71% personal)");
  });

  it("ignores soul quality stats errors when building activity", async () => {
    mockGetSoulQualityStats.mockRejectedValueOnce(new Error("stats failed"));
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Still replying." }],
      usage: { input_tokens: 60, output_tokens: 12 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "quick update",
      externalMessageId: "update:soul-stats-error",
      messageDate: 1000,
    });

    expect(result.response).toBe("Still replying.");
    expect(result.activity).not.toContain("soul v");
  });

  it("handles openai agent responses without usage metadata", async () => {
    mockConfig.telegram.llmProvider = "openai";
    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: "No usage payload" } }],
    });

    const result = await runAgent({
      chatId: "100",
      message: "Hi",
      externalMessageId: "update:1b-usage",
      messageDate: 1000,
    });

    expect(result.response).toBe("No usage payload");
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "openai",
        inputTokens: 0,
        outputTokens: 0,
      })
    );
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
      externalMessageId: "update:1c",
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
      externalMessageId: "update:1c-err",
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
      externalMessageId: "update:1d",
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
      externalMessageId: "update:1d-empty",
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
      externalMessageId: "update:1e",
      messageDate: 1000,
    });

    expect(result.response).toBe("Step 2");
    expect(mockToolHandler).toHaveBeenCalledTimes(1);
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
      externalMessageId: "update:1f",
      messageDate: 1000,
    });

    expect(result.response).toBeNull();
    expect(mockUpsertSoulState).not.toHaveBeenCalled();
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
      externalMessageId: "update:1max",
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
      externalMessageId: "update:1g",
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
      externalMessageId: "update:2",
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
      externalMessageId: "update:3",
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
      externalMessageId: "update:4",
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
      externalMessageId: "update:5",
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
      externalMessageId: "update:6",
      messageDate: 1000,
    });

    expect(result.response).toBeNull();
    expect(mockUpsertSoulState).not.toHaveBeenCalled();
  });

  it("includes retrieved patterns in system prompt", async () => {
    mockSearchPatterns.mockResolvedValueOnce([
      {
        id: 1,
        content: "User feels stressed about deadlines",
        kind: "behavior",
        confidence: 0.85,
        strength: 3,
        times_seen: 4,
        status: "active",
        temporal: null,
        canonical_hash: "abc",
        first_seen: new Date(),
        last_seen: new Date(),
        created_at: new Date(),
        score: 0.8,
        similarity: 0.9,
      },
      {
        id: 2,
        content: "User's partner is named Ana.",
        kind: "fact",
        confidence: 0.95,
        strength: 2,
        times_seen: 3,
        status: "active",
        temporal: null,
        canonical_hash: "def",
        first_seen: new Date(),
        last_seen: new Date(),
        created_at: new Date(),
        score: 0.75,
        similarity: 0.8,
      },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I remember you mentioned stress." }],
      usage: { input_tokens: 200, output_tokens: 30 },
    });

    await runAgent({
      chatId: "100",
      message: "I'm feeling really overwhelmed by everything going on",
      externalMessageId: "update:7",
      messageDate: 1000,
    });

    // Verify system prompt contains the pattern
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("User feels stressed about deadlines");
    expect(call.system).toContain("[fact] User's partner is named Ana.");
    expect(call.system).toContain("Steady Companion charter:");
    expect(call.system).toContain("Telegram HTML");
  });

  it("includes journal composition instructions in system prompt", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Entry text" }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    await runAgent({
      chatId: "100",
      message: "write the entry",
      externalMessageId: "update:compose-1",
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
      externalMessageId: "update:prefill-1",
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

  it("skips pattern retrieval and logging for short messages", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hey!" }],
      usage: { input_tokens: 50, output_tokens: 10 },
    });

    await runAgent({
      chatId: "100",
      message: "Hey",
      externalMessageId: "update:short-1",
      messageDate: 1000,
    });

    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockLogMemoryRetrieval).not.toHaveBeenCalled();
  });

  it("skips pattern retrieval for directive-only journal composition prompts", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Entry drafted." }],
      usage: { input_tokens: 70, output_tokens: 10 },
    });

    await runAgent({
      chatId: "100",
      message: "Give me the full journal entry",
      externalMessageId: "update:directive-no-retrieval",
      messageDate: 1000,
    });

    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockLogMemoryRetrieval).not.toHaveBeenCalled();
  });

  it("skips pattern retrieval for slash-command style long messages", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Handled command-like input." }],
      usage: { input_tokens: 60, output_tokens: 8 },
    });

    await runAgent({
      chatId: "100",
      message: "/compose this should be handled without memory retrieval",
      externalMessageId: "update:slash-no-retrieval",
      messageDate: 1000,
    });

    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockLogMemoryRetrieval).not.toHaveBeenCalled();
  });

  it("skips pattern retrieval for long weight logging directives", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Weight noted." }],
      usage: { input_tokens: 60, output_tokens: 8 },
    });

    await runAgent({
      chatId: "100",
      message: "Today I weigh 85kg and want this logged for today only",
      externalMessageId: "update:weight-no-retrieval",
      messageDate: 1000,
    });

    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockLogMemoryRetrieval).not.toHaveBeenCalled();
  });

  it("skips pattern retrieval for generic short imperative directives", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 60, output_tokens: 8 },
    });

    await runAgent({
      chatId: "100",
      message: "show me the latest journal draft now",
      externalMessageId: "update:imperative-no-retrieval",
      messageDate: 1000,
    });

    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockLogMemoryRetrieval).not.toHaveBeenCalled();
  });

  it("uses stricter retrieval thresholds for short memory-focused queries", async () => {
    mockSearchPatterns.mockResolvedValueOnce([
      {
        id: 12,
        content: "Low confidence pattern",
        kind: "behavior",
        confidence: 0.8,
        strength: 1,
        times_seen: 1,
        status: "active",
        temporal: null,
        canonical_hash: "short-threshold",
        first_seen: new Date(),
        last_seen: new Date(),
        created_at: new Date(),
        score: 0.49,
        similarity: 0.9,
      },
    ]);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "No memory attached." }],
      usage: { input_tokens: 90, output_tokens: 12 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "memory recall around nicotine relapse lately",
      externalMessageId: "update:short-threshold",
      messageDate: 1000,
    });

    expect(mockSearchPatterns).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      20,
      0.52
    );
    expect(result.activity).not.toContain("used 1 memories");
  });

  it("continues when embedding usage logging fails", async () => {
    mockLogApiUsage
      .mockRejectedValueOnce(new Error("usage logger offline"))
      .mockResolvedValue(undefined);
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Still responding." }],
      usage: { input_tokens: 80, output_tokens: 10 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "Tell me what patterns from this month matter most to me",
      externalMessageId: "update:embedding-log-fail",
      messageDate: 1000,
    });

    expect(result.response).toBe("Still responding.");
    expect(errorSpy).toHaveBeenCalledWith(
      "Telegram embedding usage logging failed:",
      expect.any(Error)
    );
  });

  it("omits memory kind suffix in activity when retrieved kind is blank", async () => {
    mockSearchPatterns.mockResolvedValueOnce([
      {
        id: 99,
        content: "Pattern without explicit kind label",
        kind: "",
        confidence: 0.7,
        strength: 1,
        times_seen: 1,
        status: "active",
        temporal: null,
        canonical_hash: "blank-kind",
        first_seen: new Date(),
        last_seen: new Date(),
        created_at: new Date(),
        score: 0.7,
        similarity: 0.7,
      },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Noted." }],
      usage: { input_tokens: 90, output_tokens: 12 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "I want you to remember this important detail about me",
      externalMessageId: "update:blank-kind",
      messageDate: 1000,
    });

    expect(result.activity).toContain("used 1 memories");
    expect(result.activity).not.toContain("used 1 memories (");
  });

  it("includes persisted soul state in the system prompt", async () => {
    mockGetSoulState.mockResolvedValueOnce({
      chat_id: "100",
      identity_summary: "Becoming a steady, grounded thinking partner.",
      relational_commitments: ["stay direct", "ask one useful follow-up"],
      tone_signature: ["calm", "clear"],
      growth_notes: ["user asked for less generic phrasing"],
      version: 2,
      created_at: new Date(),
      updated_at: new Date(),
    });

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I'm here with you." }],
      usage: { input_tokens: 140, output_tokens: 20 },
    });

    await runAgent({
      chatId: "100",
      message: "Need you to be more real",
      externalMessageId: "update:soul-1",
      messageDate: 1000,
    });

    expect(mockGetSoulState).toHaveBeenCalledWith(expect.anything(), "100");
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain(
      "Soul identity summary: Becoming a steady, grounded thinking partner."
    );
    expect(call.system).toContain("Relational commitments:");
    expect(call.system).toContain("Soul state version: v2");
  });

  it("injects evening review mode instructions when requested", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Starting your evening review." }],
      usage: { input_tokens: 120, output_tokens: 20 },
    });

    await runAgent({
      chatId: "100",
      message: "Start evening review now",
      externalMessageId: "update:evening-1",
      messageDate: 1000,
      mode: "evening_review",
    });

    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("Evening Review mode is ON.");
    expect(call.system).toContain(
      "Every question should appear in both English and Spanish."
    );
  });

  it("skips soul-state lookup when TELEGRAM_SOUL_ENABLED is false", async () => {
    mockConfig.telegram.soulEnabled = false;
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Understood." }],
      usage: { input_tokens: 90, output_tokens: 10 },
    });

    await runAgent({
      chatId: "100",
      message: "hello",
      externalMessageId: "update:soul-2",
      messageDate: 1000,
    });

    expect(mockGetSoulState).not.toHaveBeenCalled();
    expect(mockUpsertSoulState).not.toHaveBeenCalled();
  });

  it("logs and continues when soul persistence fails", async () => {
    mockGetSoulState.mockResolvedValueOnce({
      chat_id: "100",
      identity_summary:
        "A steady companion that is warm, direct, and emotionally present.",
      relational_commitments: ["stay direct and emotionally present"],
      tone_signature: ["warm", "direct", "grounded"],
      growth_notes: ["initialized soul state from early conversation"],
      version: 2,
      created_at: new Date(),
      updated_at: new Date(),
    });
    mockUpsertSoulState.mockRejectedValueOnce(new Error("write failed"));
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Got it, I will be more concise." }],
      usage: { input_tokens: 110, output_tokens: 16 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "be more concise",
      externalMessageId: "update:soul-write-fail",
      messageDate: 1000,
    });

    expect(result.response).toBe("Got it, I will be more concise.");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Telegram soul persistence error [chat:100]:"),
      expect.any(Error)
    );
  });

  it("handles pattern retrieval failure gracefully", async () => {
    mockGenerateEmbedding.mockRejectedValueOnce(new Error("OpenAI down"));

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hi there!" }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "Tell me what patterns you remember about me from our conversations",
      externalMessageId: "update:8",
      messageDate: 1000,
    });

    expect(result.response).toBe("Hi there!");
    expect(result.activity).toContain("memory degraded");

    // System prompt should indicate degraded memory
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("[memory: degraded]");
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
      externalMessageId: "update:9",
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
      externalMessageId: "update:10",
      messageDate: 1000,
    });

    expect(result.response).toBeTruthy();
  });

  it("applies MMR reranking when multiple patterns are retrieved", async () => {
    mockSearchPatterns.mockResolvedValueOnce([
      { id: 1, content: "Pattern A", kind: "behavior", confidence: 0.9, strength: 3, times_seen: 5, status: "active", temporal: null, canonical_hash: "a", first_seen: new Date(), last_seen: new Date(), created_at: new Date(), score: 0.9, similarity: 0.95 },
      { id: 2, content: "Pattern B", kind: "behavior", confidence: 0.8, strength: 2, times_seen: 3, status: "active", temporal: null, canonical_hash: "b", first_seen: new Date(), last_seen: new Date(), created_at: new Date(), score: 0.85, similarity: 0.90 },
      { id: 3, content: "Pattern C", kind: "emotion", confidence: 0.7, strength: 1, times_seen: 1, status: "active", temporal: null, canonical_hash: "c", first_seen: new Date(), last_seen: new Date(), created_at: new Date(), score: 0.75, similarity: 0.60 },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I see patterns." }],
      usage: { input_tokens: 200, output_tokens: 20 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "How am I doing overall with my goals and habits lately?",
      externalMessageId: "update:11",
      messageDate: 1000,
    });

    expect(result.response).toBe("I see patterns.");
    expect(result.activity).toContain("used 3 memories");
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("Pattern A");
    expect(call.system).toContain("Pattern B");
    expect(call.system).toContain("Pattern C");
  });
});

describe("compactIfNeeded — additional coverage", () => {
  it("uses openai provider for compaction extraction", async () => {
    mockConfig.telegram.llmProvider = "openai";
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

    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({
            new_patterns: [{
              content: "OpenAI extracted pattern",
              kind: "behavior",
              confidence: 0.8,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      }],
      usage: { prompt_tokens: 500, completion_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockOpenAIChatCreate).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(mockInsertPattern).toHaveBeenCalled();
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "openai",
        purpose: "compaction",
      })
    );
  });

  it("handles openai compaction responses without content/usage", async () => {
    mockConfig.telegram.llmProvider = "openai";
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

    mockOpenAIChatCreate.mockResolvedValueOnce({
      choices: [{ message: {} }],
    });

    await compactIfNeeded("100");

    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "openai",
        inputTokens: 0,
        outputTokens: 0,
      })
    );
  });

  it("includes existing patterns in extraction prompt", async () => {
    mockGetRecentMessages.mockResolvedValueOnce([]);
    mockSearchPatterns.mockResolvedValueOnce([]);

    // For compaction, return existing patterns
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

    mockGetTopPatterns.mockResolvedValueOnce([
      { id: 99, content: "Existing pattern text", kind: "behavior", confidence: 0.9, strength: 5, times_seen: 10, status: "active" },
    ]);

    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Response" }],
        usage: { input_tokens: 100, output_tokens: 10 },
      })
      .mockResolvedValueOnce({
        content: [{
          type: "text",
          text: JSON.stringify({ new_patterns: [], reinforcements: [], contradictions: [], supersedes: [] }),
        }],
        usage: { input_tokens: 500, output_tokens: 100 },
      });

    await runAgent({
      chatId: "100",
      message: "hello",
      externalMessageId: "update:20",
      messageDate: 1000,
    });

    // Wait for async compaction
    await new Promise((r) => setTimeout(r, 50));

    // Extraction prompt should include existing pattern
    const compactionCall = mockAnthropicCreate.mock.calls.find(
      (c: unknown[]) => {
        const arg = c[0] as { messages: { content: string }[] };
        return arg.messages?.[0]?.content?.includes?.("Existing pattern text");
      }
    );
    expect(compactionCall).toBeTruthy();
  });

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

  it("handles ANN similarity in 0.82-0.90 range", async () => {
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

    // Return a pattern with similarity in the 0.82-0.90 range
    mockFindSimilarPatterns.mockResolvedValueOnce([
      { id: 20, content: "Somewhat similar", kind: "behavior", confidence: 0.7, strength: 1, times_seen: 1, status: "active", similarity: 0.85 },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
            new_patterns: [{
              content: "Somewhat similar pattern",
              kind: "behavior",
              confidence: 0.75,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: ["ENTRY-ANN-1"],
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

    // Should auto-reinforce (v1 skips LLM adjudication)
    expect(mockReinforcePattern).toHaveBeenCalledWith(expect.anything(), 20, 0.75);
    expect(mockInsertPatternAlias).toHaveBeenCalled();
    expect(mockInsertPatternObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ patternId: 20 })
    );
    expect(mockLinkPatternToEntry).toHaveBeenCalledWith(
      expect.anything(),
      20,
      "ENTRY-ANN-1",
      "compaction",
      0.75
    );
    expect(mockInsertPattern).not.toHaveBeenCalled();
  });

  it("continues without embedding when generation fails during dedup", async () => {
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

    // Embedding fails during dedup (compactIfNeeded doesn't do pattern retrieval)
    mockGenerateEmbedding.mockRejectedValueOnce(new Error("rate limited"));

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({
          new_patterns: [{
            content: "Pattern without embedding",
            kind: "behavior",
            confidence: 0.7,
            signal: "explicit",
            evidence_message_ids: [1],
            entry_uuids: [],
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

    // Should still insert pattern (without embedding)
    expect(mockInsertPattern).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ embedding: null })
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

  it("returns full result for log_weight", () => {
    const result = truncateToolResult("log_weight", "Logged weight: 80.5 kg on 2025-01-10");
    expect(result).toBe("Logged weight: 80.5 kg on 2025-01-10");
  });

  it("truncates search_entries at line boundaries", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Entry ${i}: ${"y".repeat(100)}`);
    const result = truncateToolResult("search_entries", lines.join("\n"));
    expect(result.length).toBeLessThanOrEqual(600);
  });
});

describe("compactIfNeeded", () => {
  it("skips compaction when context is under budget", async () => {
    mockGetRecentMessages.mockResolvedValueOnce([
      { id: 1, role: "user", content: "short", chat_id: "100", external_message_id: null, tool_call_id: null, compacted_at: null, created_at: new Date() },
    ]);

    await compactIfNeeded("100");

    // Should not attempt to acquire lock
    expect(mockMarkMessagesCompacted).not.toHaveBeenCalled();
  });

  it("runs compaction when context exceeds budget", async () => {
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

    // First call for initial check, second for re-check after lock
    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    // Mock extraction response
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            new_patterns: [{
              content: "User experiences stress from deadlines",
              kind: "behavior",
              confidence: 0.8,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockInsertPattern).toHaveBeenCalled();
    expect(mockMarkMessagesCompacted).toHaveBeenCalled();
  });

  it("accepts fact and event kinds during compaction extraction", async () => {
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
          text: JSON.stringify({
            new_patterns: [
              {
                content: "User's partner is named Ana.",
                kind: "fact",
                confidence: 0.95,
                signal: "explicit",
                evidence_message_ids: [1],
                entry_uuids: [],
                temporal: {},
              },
              {
                content: "User moved to Barcelona in early 2024.",
                kind: "event",
                confidence: 0.88,
                signal: "explicit",
                evidence_message_ids: [2],
                entry_uuids: [],
                temporal: { date: "2024-02-01" },
              },
            ],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockInsertPattern).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "fact" })
    );
    expect(mockInsertPattern).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "event" })
    );
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

  it("handles contradictions and supersessions", async () => {
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
          text: JSON.stringify({
            new_patterns: [],
            reinforcements: [],
            contradictions: [{ pattern_id: 3, reason: "No longer accurate", evidence_message_ids: [1] }],
            supersedes: [{ old_pattern_id: 4, reason: "Replaced", new_pattern_content: "New behavior", evidence_message_ids: [2] }],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockUpdatePatternStatus).toHaveBeenCalledWith(expect.anything(), 3, "disputed");
    expect(mockUpdatePatternStatus).toHaveBeenCalledWith(expect.anything(), 4, "superseded");
    expect(mockInsertPattern).toHaveBeenCalled();
  });

  it("deduplicates via ANN and reinforces existing pattern", async () => {
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

    // Return a similar pattern for ANN check
    mockFindSimilarPatterns.mockResolvedValueOnce([
      { id: 10, content: "Similar pattern", kind: "behavior", confidence: 0.8, strength: 2, times_seen: 3, status: "active", similarity: 0.95 },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            new_patterns: [{
              content: "Almost identical pattern",
              kind: "behavior",
              confidence: 0.8,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    // Should reinforce existing rather than insert new
    expect(mockReinforcePattern).toHaveBeenCalledWith(expect.anything(), 10, 0.8);
    expect(mockInsertPatternAlias).toHaveBeenCalled();
    expect(mockInsertPatternObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ patternId: 10 })
    );
    // Should NOT insert new pattern
    expect(mockInsertPattern).not.toHaveBeenCalled();
  });

  it("supersedes stale weight facts instead of reinforcing conflicting values", async () => {
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

    mockFindSimilarPatterns.mockResolvedValueOnce([
      {
        id: 10,
        content: "The user weighs approximately 172 lb.",
        kind: "fact",
        confidence: 0.85,
        strength: 2,
        times_seen: 3,
        status: "active",
        similarity: 0.93,
      },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            new_patterns: [{
              content: "The user weighs 180 lb today.",
              kind: "fact",
              confidence: 0.92,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockUpdatePatternStatus).toHaveBeenCalledWith(
      expect.anything(),
      10,
      "superseded"
    );
    expect(mockReinforcePattern).not.toHaveBeenCalledWith(expect.anything(), 10, expect.anything());
    expect(mockInsertPattern).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "fact" })
    );
  });

  it("inserts fact patterns with weight language but no numeric unit", async () => {
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
          text: JSON.stringify({
            new_patterns: [{
              content: "The user is tracking weight trends more intentionally.",
              kind: "fact",
              confidence: 0.75,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockInsertPattern).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "fact" })
    );
  });

  it("reinforces near-identical kg weight facts instead of superseding", async () => {
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

    mockFindSimilarPatterns.mockResolvedValueOnce([
      {
        id: 11,
        content: "The user weighs approximately 78.1 kg.",
        kind: "fact",
        confidence: 0.82,
        strength: 2,
        times_seen: 2,
        status: "active",
        similarity: 0.92,
      },
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            new_patterns: [{
              content: "The user weighs 78.3 kg today.",
              kind: "fact",
              confidence: 0.9,
              signal: "explicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockReinforcePattern).toHaveBeenCalledWith(expect.anything(), 11, 0.9);
    expect(mockUpdatePatternStatus).not.toHaveBeenCalledWith(expect.anything(), 11, "superseded");
    expect(mockInsertPattern).not.toHaveBeenCalled();
  });

  it("filters evidence to user and tool_result roles only", async () => {
    const longContent = "x".repeat(10_000);
    const messages = [
      { id: 1, role: "user", content: longContent, chat_id: "100", external_message_id: null, tool_call_id: null, compacted_at: null, created_at: new Date() },
      { id: 2, role: "assistant", content: longContent, chat_id: "100", external_message_id: null, tool_call_id: null, compacted_at: null, created_at: new Date() },
      { id: 3, role: "tool_result", content: longContent, chat_id: "100", external_message_id: null, tool_call_id: "tc-1", compacted_at: null, created_at: new Date() },
      ...Array.from({ length: 17 }, (_, i) => ({
        id: i + 4,
        role: "user",
        content: longContent,
        chat_id: "100",
        external_message_id: null,
        tool_call_id: null,
        compacted_at: null,
        created_at: new Date(),
      })),
    ];

    mockGetRecentMessages
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce(messages);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            new_patterns: [{
              content: "Test pattern",
              kind: "behavior",
              confidence: 0.8,
              signal: "explicit",
              evidence_message_ids: [1, 2, 3], // includes assistant (id 2)
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    // Observation should only reference user/tool_result, not assistant
    if (mockInsertPatternObservation.mock.calls.length > 0) {
      const call = mockInsertPatternObservation.mock.calls[0][1];
      expect(call.chatMessageIds).not.toContain(2); // assistant id
      expect(call.evidenceRoles).not.toContain("assistant");
    }
  });

  it("halves observation confidence for implicit extracted patterns", async () => {
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
          text: JSON.stringify({
            new_patterns: [{
              content: "Implicit pattern about pacing and rest.",
              kind: "behavior",
              confidence: 0.8,
              signal: "implicit",
              evidence_message_ids: [1],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockInsertPatternObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        confidence: 0.4,
      })
    );
  });

  it("skips reinforcement updates when evidence only points to assistant messages", async () => {
    const longContent = "x".repeat(10_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      role: i === 1 ? "assistant" : "user",
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
              pattern_id: 7,
              confidence: 0.9,
              signal: "explicit",
              evidence_message_ids: [2], // assistant-only evidence gets filtered out
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

    expect(mockReinforcePattern).not.toHaveBeenCalledWith(expect.anything(), 7, expect.anything());
    expect(mockInsertPatternObservation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ patternId: 7 })
    );
    expect(mockLinkPatternToEntry).not.toHaveBeenCalledWith(
      expect.anything(),
      7,
      "ENTRY-001",
      "compaction",
      0.9
    );
  });

  it("skips extracted patterns when no valid evidence ids are provided", async () => {
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
          text: JSON.stringify({
            new_patterns: [{
              content: "User values clean structure in planning.",
              kind: "preference",
              confidence: 0.8,
              signal: "explicit",
              evidence_message_ids: [],
              entry_uuids: [],
              temporal: {},
            }],
            reinforcements: [],
            contradictions: [],
            supersedes: [],
          }),
        },
      ],
      usage: { input_tokens: 500, output_tokens: 100 },
    });

    await compactIfNeeded("100");

    expect(mockInsertPattern).not.toHaveBeenCalled();
    expect(mockInsertPatternObservation).not.toHaveBeenCalled();
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

describe("forceCompact", () => {
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

// ---------------------------------------------------------------------------
// Pulse check integration (Phase 5: self-healing organism)
// ---------------------------------------------------------------------------

describe("pulse check after compaction", () => {
  beforeEach(() => {
    mockConfig.telegram.llmProvider = "anthropic";
    mockConfig.telegram.soulEnabled = true;
    mockConfig.telegram.pulseEnabled = true;
    mockConfig.telegram.pulseIntervalHours = 24;
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
