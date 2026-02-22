import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: mockCreate },
  })),
}));

vi.mock("../../src/config.js", () => ({
  config: {
    openai: {
      apiKey: "test-key",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    },
  },
}));

import {
  generateEmbedding,
  generateEmbeddingWithUsage,
  generateEmbeddingsBatch,
  generateEmbeddingsBatchWithUsage,
} from "../../src/db/embeddings.js";

describe("generateEmbedding", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("returns the embedding vector", async () => {
    mockCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
    });

    const result = await generateEmbedding("test text");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("passes correct model and dimensions to OpenAI", async () => {
    mockCreate.mockResolvedValue({
      data: [{ embedding: [0.1], index: 0 }],
    });

    await generateEmbedding("hello");

    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: "hello",
      dimensions: 1536,
    });
  });

  it("returns usage metadata when available", async () => {
    mockCreate.mockResolvedValue({
      data: [{ embedding: [0.4, 0.5], index: 0 }],
      usage: { total_tokens: 12, prompt_tokens: 11 },
    });

    const result = await generateEmbeddingWithUsage("usage text");
    expect(result).toEqual({
      embedding: [0.4, 0.5],
      inputTokens: 12,
    });
  });

  it("falls back to prompt_tokens and then 0 for embedding usage", async () => {
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: [0.7], index: 0 }],
      usage: { prompt_tokens: 9 },
    });
    const withPromptFallback = await generateEmbeddingWithUsage("prompt-only");
    expect(withPromptFallback.inputTokens).toBe(9);

    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: [0.8], index: 0 }],
    });
    const withDefaultZero = await generateEmbeddingWithUsage("no-usage");
    expect(withDefaultZero.inputTokens).toBe(0);
  });
});

describe("generateEmbeddingsBatch", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("returns empty array for empty input", async () => {
    const result = await generateEmbeddingsBatch([]);
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns empty embeddings result with usage metadata for empty input", async () => {
    const result = await generateEmbeddingsBatchWithUsage([]);
    expect(result).toEqual({ embeddings: [], inputTokens: 0 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("sorts results by index to match input order", async () => {
    mockCreate.mockResolvedValue({
      data: [
        { embedding: [0.3], index: 2 },
        { embedding: [0.1], index: 0 },
        { embedding: [0.2], index: 1 },
      ],
    });

    const result = await generateEmbeddingsBatch(["a", "b", "c"]);
    expect(result).toEqual([[0.1], [0.2], [0.3]]);
  });

  it("passes all texts in a single batch call", async () => {
    mockCreate.mockResolvedValue({
      data: [
        { embedding: [0.1], index: 0 },
        { embedding: [0.2], index: 1 },
      ],
    });

    await generateEmbeddingsBatch(["hello", "world"]);

    expect(mockCreate).toHaveBeenCalledWith({
      model: "text-embedding-3-small",
      input: ["hello", "world"],
      dimensions: 1536,
    });
  });

  it("returns usage metadata for batch embeddings", async () => {
    mockCreate.mockResolvedValue({
      data: [
        { embedding: [0.1], index: 0 },
        { embedding: [0.2], index: 1 },
      ],
      usage: { prompt_tokens: 14 },
    });

    const result = await generateEmbeddingsBatchWithUsage(["hello", "world"]);
    expect(result).toEqual({
      embeddings: [[0.1], [0.2]],
      inputTokens: 14,
    });
  });
});

describe("generateEmbedding without API key", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("throws when OPENAI_API_KEY is missing", async () => {
    vi.doMock("../../src/config.js", () => ({
      config: {
        openai: {
          apiKey: "",
          embeddingModel: "text-embedding-3-small",
          embeddingDimensions: 1536,
        },
      },
    }));

    const { generateEmbedding: genEmbed } = await import(
      "../../src/db/embeddings.js"
    );
    await expect(genEmbed("test")).rejects.toThrow("OPENAI_API_KEY");
  });
});
