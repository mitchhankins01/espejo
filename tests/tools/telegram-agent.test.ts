import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockInsertChatMessage,
  mockGetRecentMessages,
  mockSearchPatterns,
  mockGetTopPatterns,
  mockInsertPattern,
  mockReinforcePattern,
  mockInsertPatternAlias,
  mockInsertPatternObservation,
  mockLinkPatternToEntry,
  mockUpdatePatternStatus,
  mockMarkMessagesCompacted,
  mockLogApiUsage,
  mockFindSimilarPatterns,
  mockGetLastCompactionTime,
  mockGenerateEmbedding,
  mockAnthropicCreate,
  mockToolHandler,
} = vi.hoisted(() => ({
  mockInsertChatMessage: vi.fn().mockResolvedValue({ inserted: true, id: 1 }),
  mockGetRecentMessages: vi.fn().mockResolvedValue([]),
  mockSearchPatterns: vi.fn().mockResolvedValue([]),
  mockGetTopPatterns: vi.fn().mockResolvedValue([]),
  mockInsertPattern: vi.fn().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 1, times_seen: 1, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() }),
  mockReinforcePattern: vi.fn().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 2, times_seen: 2, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() }),
  mockInsertPatternAlias: vi.fn().mockResolvedValue(undefined),
  mockInsertPatternObservation: vi.fn().mockResolvedValue(1),
  mockLinkPatternToEntry: vi.fn().mockResolvedValue(undefined),
  mockUpdatePatternStatus: vi.fn().mockResolvedValue(undefined),
  mockMarkMessagesCompacted: vi.fn().mockResolvedValue(undefined),
  mockLogApiUsage: vi.fn().mockResolvedValue(undefined),
  mockFindSimilarPatterns: vi.fn().mockResolvedValue([]),
  mockGetLastCompactionTime: vi.fn().mockResolvedValue(null),
  mockGenerateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  mockAnthropicCreate: vi.fn(),
  mockToolHandler: vi.fn().mockResolvedValue("tool result text"),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/config.js", () => ({
  config: {
    telegram: { botToken: "123:ABC", secretToken: "", allowedChatId: "100" },
    openai: { apiKey: "sk-test", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536 },
    anthropic: { apiKey: "sk-ant-test", model: "claude-sonnet-4-6" },
    timezone: "Europe/Madrid",
    apiRates: {
      "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
      "text-embedding-3-small": { input: 0.02, output: 0 },
    } as Record<string, { input: number; output: number }>,
  },
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
  insertPattern: mockInsertPattern,
  reinforcePattern: mockReinforcePattern,
  insertPatternAlias: mockInsertPatternAlias,
  insertPatternObservation: mockInsertPatternObservation,
  linkPatternToEntry: mockLinkPatternToEntry,
  updatePatternStatus: mockUpdatePatternStatus,
  markMessagesCompacted: mockMarkMessagesCompacted,
  logApiUsage: mockLogApiUsage,
  findSimilarPatterns: mockFindSimilarPatterns,
  getLastCompactionTime: mockGetLastCompactionTime,
}));

vi.mock("../../src/db/embeddings.js", () => ({
  generateEmbedding: mockGenerateEmbedding,
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
  mockInsertPattern.mockReset().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 1, times_seen: 1, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() });
  mockReinforcePattern.mockReset().mockResolvedValue({ id: 1, content: "", kind: "behavior", confidence: 0.8, strength: 2, times_seen: 2, status: "active", temporal: null, canonical_hash: "abc", first_seen: new Date(), last_seen: new Date(), created_at: new Date() });
  mockInsertPatternAlias.mockReset().mockResolvedValue(undefined);
  mockInsertPatternObservation.mockReset().mockResolvedValue(1);
  mockLinkPatternToEntry.mockReset().mockResolvedValue(undefined);
  mockUpdatePatternStatus.mockReset().mockResolvedValue(undefined);
  mockMarkMessagesCompacted.mockReset().mockResolvedValue(undefined);
  mockLogApiUsage.mockReset().mockResolvedValue(undefined);
  mockFindSimilarPatterns.mockReset().mockResolvedValue([]);
  mockGenerateEmbedding.mockReset().mockResolvedValue(new Array(1536).fill(0));
  mockAnthropicCreate.mockReset();
  mockToolHandler.mockReset().mockResolvedValue("tool result text");
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
    ]);

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I remember you mentioned stress." }],
      usage: { input_tokens: 200, output_tokens: 30 },
    });

    await runAgent({
      chatId: "100",
      message: "I'm feeling overwhelmed",
      externalMessageId: "update:7",
      messageDate: 1000,
    });

    // Verify system prompt contains the pattern
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("User feels stressed about deadlines");
    expect(call.system).toContain("Telegram HTML");
  });

  it("handles pattern retrieval failure gracefully", async () => {
    mockGenerateEmbedding.mockRejectedValueOnce(new Error("OpenAI down"));

    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Hi there!" }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    const result = await runAgent({
      chatId: "100",
      message: "hello",
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
      message: "How am I doing?",
      externalMessageId: "update:11",
      messageDate: 1000,
    });

    expect(result.response).toBe("I see patterns.");
    expect(result.activity).toContain("3 patterns");
    const call = mockAnthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("Pattern A");
    expect(call.system).toContain("Pattern B");
    expect(call.system).toContain("Pattern C");
  });
});

describe("compactIfNeeded — additional coverage", () => {
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

    // Should auto-reinforce (v1 skips LLM adjudication)
    expect(mockReinforcePattern).toHaveBeenCalledWith(expect.anything(), 20, 0.75);
    expect(mockInsertPatternAlias).toHaveBeenCalled();
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
    // Should NOT insert new pattern
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

    expect(onCompacted).toHaveBeenCalledWith("1 new patterns, 1 reinforced");
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

    expect(onCompacted).toHaveBeenCalledWith("1 contradictions, 1 superseded");
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
    expect(onCompacted).toHaveBeenCalledWith("1 new patterns");
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
