import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockGetRecentMessages,
  mockInsertSpanishAssessment,
  mockLogApiUsage,
  mockPool,
} = vi.hoisted(() => ({
  mockGetRecentMessages: vi.fn(),
  mockInsertSpanishAssessment: vi.fn(),
  mockLogApiUsage: vi.fn(),
  mockPool: {},
}));

vi.mock("../../src/db/queries.js", () => ({
  getRecentMessages: mockGetRecentMessages,
  insertSpanishAssessment: mockInsertSpanishAssessment,
  logApiUsage: mockLogApiUsage,
}));

import {
  assessSpanishQuality,
  formatSampleForAssessment,
  formatAssessmentSummary,
  createOpenAIAssessmentClient,
  type AssessmentLlmClient,
} from "../../src/spanish/assessment.js";
import type { ChatMessageRow, SpanishAssessmentRow } from "../../src/db/queries.js";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockMessages(count: number, role = "user"): ChatMessageRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    chat_id: "100",
    external_message_id: `msg-${i}`,
    role,
    content: `Hola, esta es una prueba número ${i + 1}`,
    tool_call_id: null,
    compacted_at: null,
    created_at: new Date(),
  }));
}

function mockLlmClient(overrides?: Partial<{
  complexity_score: number;
  grammar_score: number;
  vocabulary_score: number;
  code_switching_ratio: number;
  overall_score: number;
  rationale: string;
}>): AssessmentLlmClient {
  return {
    assess: vi.fn().mockResolvedValue({
      result: {
        complexity_score: 3.5,
        grammar_score: 4.0,
        vocabulary_score: 3.2,
        code_switching_ratio: 0.8,
        overall_score: 3.6,
        rationale: "Good progress with some grammar gaps.",
        ...overrides,
      },
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.001,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assessSpanishQuality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogApiUsage.mockResolvedValue(undefined);
  });

  it("throws when fewer than 3 user messages", async () => {
    // Return mix of user and assistant messages, but only 2 user messages
    mockGetRecentMessages.mockResolvedValue([
      ...makeMockMessages(2, "user"),
      ...makeMockMessages(5, "assistant"),
    ]);

    await expect(
      assessSpanishQuality(mockPool as unknown as pg.Pool, "100", mockLlmClient())
    ).rejects.toThrow("Not enough user messages");
  });

  it("samples user messages, calls LLM, stores assessment", async () => {
    const allMessages = [
      ...makeMockMessages(5, "user"),
      ...makeMockMessages(5, "assistant"),
    ];
    mockGetRecentMessages.mockResolvedValue(allMessages);
    mockInsertSpanishAssessment.mockResolvedValue({
      id: 1,
      chat_id: "100",
      complexity_score: 3.5,
      grammar_score: 4.0,
      vocabulary_score: 3.2,
      code_switching_ratio: 0.8,
      overall_score: 3.6,
      sample_message_count: 5,
      rationale: "Good progress with some grammar gaps.",
      assessed_at: new Date(),
    });

    const client = mockLlmClient();
    const result = await assessSpanishQuality(
      mockPool as unknown as pg.Pool,
      "100",
      client
    );

    expect(client.assess).toHaveBeenCalledOnce();
    expect(mockInsertSpanishAssessment).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        chatId: "100",
        complexityScore: 3.5,
        grammarScore: 4.0,
        vocabularyScore: 3.2,
        codeSwitchingRatio: 0.8,
        overallScore: 3.6,
        sampleMessageCount: 5,
      })
    );
    expect(mockLogApiUsage).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ purpose: "assessment" })
    );
    expect(result.assessment.overall_score).toBe(3.6);
    expect(result.summary).toContain("3.6/5");
  });

  it("uses fallback rationale when LLM returns empty string", async () => {
    const allMessages = makeMockMessages(5, "user");
    mockGetRecentMessages.mockResolvedValue(allMessages);
    mockInsertSpanishAssessment.mockResolvedValue({
      id: 1,
      chat_id: "100",
      complexity_score: 3.0,
      grammar_score: 3.0,
      vocabulary_score: 3.0,
      code_switching_ratio: 0.7,
      overall_score: 3.0,
      sample_message_count: 5,
      rationale: "No rationale provided.",
      assessed_at: new Date(),
    });

    const client = mockLlmClient({ rationale: "" as unknown as string });
    await assessSpanishQuality(mockPool as unknown as pg.Pool, "100", client);

    expect(mockInsertSpanishAssessment).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ rationale: "No rationale provided." })
    );
  });

  it("limits sample to 20 most recent user messages", async () => {
    const allMessages = makeMockMessages(30, "user");
    mockGetRecentMessages.mockResolvedValue(allMessages);
    mockInsertSpanishAssessment.mockResolvedValue({
      id: 1,
      chat_id: "100",
      complexity_score: 3.0,
      grammar_score: 3.0,
      vocabulary_score: 3.0,
      code_switching_ratio: 0.7,
      overall_score: 3.0,
      sample_message_count: 20,
      rationale: "Consistent performance.",
      assessed_at: new Date(),
    });

    const client = mockLlmClient();
    await assessSpanishQuality(mockPool as unknown as pg.Pool, "100", client);

    expect(mockInsertSpanishAssessment).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ sampleMessageCount: 20 })
    );
  });

  it("clamps scores to valid ranges", async () => {
    mockGetRecentMessages.mockResolvedValue(makeMockMessages(5, "user"));
    mockInsertSpanishAssessment.mockImplementation((_pool, params) => ({
      ...params,
      id: 1,
      chat_id: params.chatId,
      complexity_score: params.complexityScore,
      grammar_score: params.grammarScore,
      vocabulary_score: params.vocabularyScore,
      code_switching_ratio: params.codeSwitchingRatio,
      overall_score: params.overallScore,
      sample_message_count: params.sampleMessageCount,
      rationale: params.rationale,
      assessed_at: new Date(),
    }));

    const client = mockLlmClient({
      complexity_score: 7.0, // over max
      grammar_score: -1.0,   // under min
      code_switching_ratio: 1.5, // over 1.0
    });

    await assessSpanishQuality(mockPool as unknown as pg.Pool, "100", client);

    expect(mockInsertSpanishAssessment).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        complexityScore: 5, // clamped to max
        grammarScore: 1,    // clamped to min
        codeSwitchingRatio: 1, // clamped to 1.0
      })
    );
  });
});

// ============================================================================
// formatSampleForAssessment
// ============================================================================

describe("formatSampleForAssessment", () => {
  it("numbers messages sequentially", () => {
    const messages = makeMockMessages(3, "user");
    const result = formatSampleForAssessment(messages);
    expect(result).toContain("[1]");
    expect(result).toContain("[2]");
    expect(result).toContain("[3]");
  });

  it("separates messages with double newlines", () => {
    const messages = makeMockMessages(2, "user");
    const result = formatSampleForAssessment(messages);
    expect(result).toContain("\n\n");
  });
});

// ============================================================================
// formatAssessmentSummary
// ============================================================================

describe("formatAssessmentSummary", () => {
  const assessment: SpanishAssessmentRow = {
    id: 1,
    chat_id: "100",
    complexity_score: 3.5,
    grammar_score: 4.0,
    vocabulary_score: 3.2,
    code_switching_ratio: 0.82,
    overall_score: 3.6,
    sample_message_count: 15,
    rationale: "Good progress overall.",
    assessed_at: new Date("2026-02-23"),
  };

  it("includes overall score", () => {
    const text = formatAssessmentSummary(assessment);
    expect(text).toContain("3.6/5");
  });

  it("includes component scores", () => {
    const text = formatAssessmentSummary(assessment);
    expect(text).toContain("Complexity: 3.5");
    expect(text).toContain("Grammar: 4.0");
    expect(text).toContain("Vocabulary: 3.2");
  });

  it("includes code switching ratio as percentage", () => {
    const text = formatAssessmentSummary(assessment);
    expect(text).toContain("82%");
  });

  it("includes rationale", () => {
    const text = formatAssessmentSummary(assessment);
    expect(text).toContain("Good progress overall.");
  });

  it("includes sample message count", () => {
    const text = formatAssessmentSummary(assessment);
    expect(text).toContain("15 messages");
  });
});

// ============================================================================
// createOpenAIAssessmentClient
// ============================================================================

describe("createOpenAIAssessmentClient", () => {
  it("calls OpenAI with correct parameters and parses response", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            complexity_score: 3.0,
            grammar_score: 3.5,
            vocabulary_score: 3.0,
            code_switching_ratio: 0.7,
            overall_score: 3.2,
            rationale: "Decent progress.",
          }),
        },
      }],
      usage: { prompt_tokens: 200, completion_tokens: 50 },
    });

    const client = createOpenAIAssessmentClient({
      chat: { completions: { create: mockCreate } },
    });

    const result = await client.assess("system prompt", "user prompt");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
      })
    );
    expect(result.result.overall_score).toBe(3.2);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(50);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("handles missing usage data", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            complexity_score: 3.0,
            grammar_score: 3.0,
            vocabulary_score: 3.0,
            code_switching_ratio: 0.5,
            overall_score: 3.0,
            rationale: "OK.",
          }),
        },
      }],
      // no usage field
    });

    const client = createOpenAIAssessmentClient({
      chat: { completions: { create: mockCreate } },
    });

    const result = await client.assess("system", "user");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it("handles null content gracefully", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    });

    const client = createOpenAIAssessmentClient({
      chat: { completions: { create: mockCreate } },
    });

    const result = await client.assess("system", "user");
    // Should parse "{}" as empty object — scores will be undefined
    expect(result.result).toBeDefined();
  });
});
