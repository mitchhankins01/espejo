import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they can be referenced in vi.mock factories
// ---------------------------------------------------------------------------

const mockArtifactQueries = vi.hoisted(() => ({
  searchArtifacts: vi.fn().mockResolvedValue([]),
  findDuplicateInsightByEmbedding: vi.fn().mockResolvedValue(null),
}));

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  generateEmbeddingsBatch: vi.fn(),
}));

const mockR2 = vi.hoisted(() => ({
  createClient: vi.fn().mockReturnValue({}),
  putObjectContent: vi.fn().mockResolvedValue(undefined),
}));

const mockTelegram = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
}));

const mockAnthropic = vi.hoisted(() => {
  const createFn = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: createFn },
    })),
    __createFn: createFn,
  };
});

const mockConfig = vi.hoisted(() => ({
  config: {
    anthropic: { apiKey: "test-key", model: "claude-opus-4-6" },
    r2: { accountId: "test", accessKeyId: "test", secretAccessKey: "test" },
    openai: { apiKey: "test", embeddingModel: "text-embedding-3-small", embeddingDimensions: 1536 },
    telegram: { botToken: "test", allowedChatId: "123" },
  },
}));

vi.mock("../../src/db/queries/artifacts.js", () => mockArtifactQueries);
vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);
vi.mock("../../src/storage/r2.js", () => mockR2);
vi.mock("../../src/telegram/client.js", () => mockTelegram);
vi.mock("@anthropic-ai/sdk", () => mockAnthropic);
vi.mock("../../src/config.js", () => mockConfig);

import { extractInsightsFromReview, extractAndNotifyReviews } from "../../src/obsidian/extraction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockPool = { query: vi.fn() } as any;

function makeLlmResponse(insights: Array<{ title: string; body: string; linkedTo?: string[] }>): string {
  return JSON.stringify({
    insights: insights.map((i) => ({
      title: i.title,
      body: i.body,
      linkedTo: i.linkedTo ?? [],
    })),
  });
}

function setupLlmResponse(insights: Array<{ title: string; body: string; linkedTo?: string[] }>): void {
  mockAnthropic.__createFn.mockResolvedValue({
    content: [{ type: "text", text: makeLlmResponse(insights) }],
  });
}

/** Generate a deterministic embedding for testing */
function makeEmbedding(seed: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < 1536; i++) {
    vec.push(Math.sin(seed * 0.1 + i * 0.01) * 0.5 + Math.cos(seed * 0.3 + i * 0.02) * 0.3);
  }
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return vec.map((v) => v / mag);
}

/** Generate a slightly different embedding (high similarity to base) */
function makeNearDuplicate(seed: number, noiseSeed: number, amount = 0.005): number[] {
  const base = makeEmbedding(seed);
  const noisy = base.map((v, i) => v + Math.sin(noiseSeed * 7.3 + i * 0.13) * amount);
  const mag = Math.sqrt(noisy.reduce((sum, v) => sum + v * v, 0));
  return noisy.map((v) => v / mag);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockArtifactQueries.searchArtifacts.mockResolvedValue([]);
  mockArtifactQueries.findDuplicateInsightByEmbedding.mockResolvedValue(null);
  mockEmbeddings.generateEmbedding.mockResolvedValue(new Array(1536).fill(0));
});

describe("extractInsightsFromReview — dedup", () => {
  it("writes insight without duplicate_of when no match found", async () => {
    setupLlmResponse([{ title: "Unique idea", body: "This is new." }]);
    const emb = makeEmbedding(1);
    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([emb]);

    const result = await extractInsightsFromReview(mockPool, "Review Title", "Review body text");

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].duplicateOf).toBeUndefined();
    expect(result.filesWritten).toHaveLength(1);

    // Verify frontmatter does NOT contain duplicate_of
    const writtenMarkdown = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(writtenMarkdown).toContain("kind: insight");
    expect(writtenMarkdown).not.toContain("duplicate_of");
  });

  it("marks insight as duplicate when DB match found (similarity >= 0.92)", async () => {
    setupLlmResponse([{ title: "Same old idea", body: "Already exists." }]);
    const emb = makeEmbedding(1);
    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([emb]);
    mockArtifactQueries.findDuplicateInsightByEmbedding.mockResolvedValue({
      id: "existing-uuid-123",
      title: "Original idea",
      similarity: 0.95,
    });

    const result = await extractInsightsFromReview(mockPool, "Review", "Body");

    expect(result.insights[0].duplicateOf).toEqual({
      id: "existing-uuid-123",
      title: "Original idea",
    });

    // Verify frontmatter contains duplicate_of
    const writtenMarkdown = mockR2.putObjectContent.mock.calls[0][3] as string;
    expect(writtenMarkdown).toContain("duplicate_of: existing-uuid-123");
  });

  it("detects intra-batch duplicates (second candidate matches first)", async () => {
    setupLlmResponse([
      { title: "First idea", body: "The original." },
      { title: "Same idea rephrased", body: "Still the original." },
    ]);

    // Two very similar embeddings for intra-batch detection
    const emb1 = makeEmbedding(42);
    const emb2 = makeNearDuplicate(42, 1, 0.001); // very close
    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([emb1, emb2]);

    const result = await extractInsightsFromReview(mockPool, "Review", "Body");

    expect(result.insights[0].duplicateOf).toBeUndefined();
    expect(result.insights[1].duplicateOf).toEqual({
      id: "batch",
      title: "First idea",
    });
  });

  it("skips dedup gracefully when embedding generation fails (fail-open)", async () => {
    setupLlmResponse([{ title: "Good insight", body: "Content here." }]);
    mockEmbeddings.generateEmbeddingsBatch.mockRejectedValue(new Error("OpenAI rate limit"));

    const result = await extractInsightsFromReview(mockPool, "Review", "Body");

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].duplicateOf).toBeUndefined();
    expect(result.filesWritten).toHaveLength(1);
    // Should NOT have called the DB dedup check
    expect(mockArtifactQueries.findDuplicateInsightByEmbedding).not.toHaveBeenCalled();
  });

  it("continues writing when DB dedup check fails for one insight", async () => {
    setupLlmResponse([
      { title: "First", body: "A." },
      { title: "Second", body: "B." },
    ]);
    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);
    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([emb1, emb2]);
    mockArtifactQueries.findDuplicateInsightByEmbedding
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce({ id: "dup-id", title: "Existing", similarity: 0.93 });

    const result = await extractInsightsFromReview(mockPool, "Review", "Body");

    expect(result.insights[0].duplicateOf).toBeUndefined(); // DB failed, no dedup
    expect(result.insights[1].duplicateOf).toEqual({ id: "dup-id", title: "Existing" });
    expect(result.filesWritten).toHaveLength(2); // Both still written
  });

  it("returns empty insights when LLM finds nothing to extract", async () => {
    setupLlmResponse([]);
    const result = await extractInsightsFromReview(mockPool, "Review", "Body");

    expect(result.insights).toHaveLength(0);
    expect(result.filesWritten).toHaveLength(0);
    // Should not attempt embedding at all
    expect(mockEmbeddings.generateEmbeddingsBatch).not.toHaveBeenCalled();
  });

  it("DB match takes priority over intra-batch match", async () => {
    setupLlmResponse([
      { title: "First", body: "A." },
      { title: "Second similar", body: "Also A." },
    ]);
    const emb1 = makeEmbedding(42);
    const emb2 = makeNearDuplicate(42, 1, 0.001);
    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([emb1, emb2]);

    // DB finds match for the second insight
    mockArtifactQueries.findDuplicateInsightByEmbedding
      .mockResolvedValueOnce(null) // first: no DB match
      .mockResolvedValueOnce({ id: "db-original", title: "DB Original", similarity: 0.94 }); // second: DB match

    const result = await extractInsightsFromReview(mockPool, "Review", "Body");

    // Second should be marked as DB duplicate, not intra-batch
    expect(result.insights[1].duplicateOf).toEqual({ id: "db-original", title: "DB Original" });
  });
});

describe("extractAndNotifyReviews — duplicate notification", () => {
  it("distinguishes new vs duplicate insights in Telegram message", async () => {
    setupLlmResponse([
      { title: "New insight", body: "Fresh." },
      { title: "Old insight", body: "Repeat." },
    ]);

    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);
    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([emb1, emb2]);
    mockArtifactQueries.findDuplicateInsightByEmbedding
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "orig-id", title: "Original", similarity: 0.93 });

    await extractAndNotifyReviews(mockPool, [{ title: "Evening Review", body: "Review content" }]);

    expect(mockTelegram.sendTelegramMessage).toHaveBeenCalledOnce();
    const message = mockTelegram.sendTelegramMessage.mock.calls[0][1] as string;
    expect(message).toContain("1 new, 1 duplicate");
    expect(message).toContain("💡 New insight");
    expect(message).toContain("🔁 Old insight");
    expect(message).toContain('duplicate of "Original"');
  });
});

describe("parseObsidianNote — duplicate_of extraction", () => {
  // Test the parser separately to verify frontmatter propagation
  it("extracts duplicate_of UUID from frontmatter", async () => {
    // Dynamic import to avoid mock interference
    const { parseObsidianNote } = await import("../../src/obsidian/parser.js");
    const content = `---
kind: insight
duplicate_of: 550e8400-e29b-41d4-a716-446655440000
---
# Test Insight

Some body text.
`;
    const parsed = parseObsidianNote(content, "test.md");
    expect(parsed.kind).toBe("insight");
    expect(parsed.duplicateOf).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("omits duplicateOf when not present in frontmatter", async () => {
    const { parseObsidianNote } = await import("../../src/obsidian/parser.js");
    const content = `---
kind: insight
---
# Regular Insight

Body text.
`;
    const parsed = parseObsidianNote(content, "test.md");
    expect(parsed.duplicateOf).toBeUndefined();
  });

  it("ignores invalid (non-UUID) duplicate_of values", async () => {
    const { parseObsidianNote } = await import("../../src/obsidian/parser.js");
    const content = `---
kind: insight
duplicate_of: not-a-uuid
---
# Test

Body.
`;
    const parsed = parseObsidianNote(content, "test.md");
    expect(parsed.duplicateOf).toBeUndefined();
  });
});
