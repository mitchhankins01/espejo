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

    expect(result).toEqual({ entries: 0, artifacts: 0, skipped: [] });
  });

  it("embeds entries missing embeddings", async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { id: 1, text: "Hello world" },
          { id: 2, text: "Another entry" },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    const result = await embedPending(mockPool);

    expect(result.entries).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledWith([
      "Hello world",
      "Another entry",
    ]);
  });

  it("embeds artifacts missing embeddings", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: "art-001", title: "Title", body: "Body text" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([[0.5, 0.6]]);

    const result = await embedPending(mockPool);

    expect(result.artifacts).toBe(1);
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledWith([
      "Title\n\nBody text",
    ]);
  });

  it("skips oversized entries and reports them", async () => {
    const longText = "A".repeat(30000);
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ id: 1, text: longText }],
      })
      // Entire batch skipped → breaks loop
      .mockResolvedValueOnce({ rows: [] }); // artifacts

    const result = await embedPending(mockPool);

    expect(result.entries).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      type: "entry",
      id: 1,
      chars: 30000,
    });
    expect(mockEmbeddings.generateEmbeddingsBatch).not.toHaveBeenCalled();
  });

  it("skips oversized artifacts and reports them", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // entries
      .mockResolvedValueOnce({
        rows: [{ id: "art-001", title: "Big Review", body: "B".repeat(30000) }],
      })
      .mockResolvedValueOnce({ rows: [] }); // artifacts done after skip

    const result = await embedPending(mockPool);

    expect(result.artifacts).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      type: "artifact",
      id: "art-001",
      title: "Big Review",
    });
  });

  it("embeds normal items and skips oversized in same batch", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // entries
      .mockResolvedValueOnce({
        rows: [
          { id: "art-001", title: "Small", body: "short body" },
          { id: "art-002", title: "Huge", body: "C".repeat(30000) },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // artifacts done

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([[0.1, 0.2]]);

    const result = await embedPending(mockPool);

    expect(result.artifacts).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].title).toBe("Huge");
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledWith([
      "Small\n\nshort body",
    ]);
  });

  it("processes multiple batches", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, text: "First" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 2, text: "Second" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([[0.1, 0.2]]);

    const result = await embedPending(mockPool);

    expect(result.entries).toBe(2);
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledTimes(2);
  });
});
