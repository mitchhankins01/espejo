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
  generateEmbeddingsBatch,
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
