import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbeddingsBatch: vi.fn(),
}));

vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);

import { embedPending } from "../../src/db/embed-pending.js";

const mockPool = {
  query: vi.fn(),
} as any;

beforeEach(() => {
  mockPool.query.mockReset();
  mockEmbeddings.generateEmbeddingsBatch.mockReset();
});

describe("embedPending", () => {
  it("returns zeros when nothing to embed", async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const result = await embedPending(mockPool);

    expect(result).toEqual({ entries: 0, artifacts: 0 });
  });

  it("embeds entries missing embeddings", async () => {
    mockPool.query
      // First call: fetch entries batch
      .mockResolvedValueOnce({
        rows: [
          { id: 1, text: "Hello world" },
          { id: 2, text: "Another entry" },
        ],
      })
      // Second call: UPDATE entries
      .mockResolvedValueOnce({ rowCount: 2 })
      // Third call: fetch entries batch (empty = done)
      .mockResolvedValueOnce({ rows: [] })
      // Fourth call: fetch artifacts batch (empty)
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    const result = await embedPending(mockPool);

    expect(result.entries).toBe(2);
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledWith([
      "Hello world",
      "Another entry",
    ]);
  });

  it("embeds artifacts missing embeddings", async () => {
    mockPool.query
      // Entries: empty
      .mockResolvedValueOnce({ rows: [] })
      // Artifacts: one batch
      .mockResolvedValueOnce({
        rows: [{ id: "art-001", title: "Title", body: "Body text" }],
      })
      // UPDATE artifacts
      .mockResolvedValueOnce({ rowCount: 1 })
      // Artifacts: empty = done
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([[0.5, 0.6]]);

    const result = await embedPending(mockPool);

    expect(result.artifacts).toBe(1);
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledWith([
      "Title\n\nBody text",
    ]);
  });

  it("truncates oversized texts", async () => {
    const longText = "A".repeat(30000);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, text: longText }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([[0.1, 0.2]]);

    await embedPending(mockPool);

    const calledWith = mockEmbeddings.generateEmbeddingsBatch.mock.calls[0][0][0] as string;
    expect(calledWith.length).toBe(25000);
  });

  it("processes multiple batches", async () => {
    mockPool.query
      // Entries batch 1
      .mockResolvedValueOnce({
        rows: [{ id: 1, text: "First" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      // Entries batch 2
      .mockResolvedValueOnce({
        rows: [{ id: 2, text: "Second" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      // Entries done
      .mockResolvedValueOnce({ rows: [] })
      // Artifacts done
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([[0.1, 0.2]]);

    const result = await embedPending(mockPool);

    expect(result.entries).toBe(2);
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledTimes(2);
  });
});
