import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbeddingsBatch: vi.fn(),
}));

vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);

import {
  embedPending,
  chunkText,
  averageVectors,
} from "../../src/db/embed-pending.js";

const mockPool = {
  query: vi.fn(),
} as any;

beforeEach(() => {
  mockPool.query.mockReset();
  mockEmbeddings.generateEmbeddingsBatch.mockReset();
});

describe("chunkText", () => {
  it("returns single chunk for text under MAX_CHARS", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  it("splits oversized text on paragraph boundaries", () => {
    const para = "A".repeat(15000);
    const text = `${para}\n\n${para}`; // 30002 chars
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para);
    expect(chunks[1]).toBe(para);
  });

  it("hard-slices a single oversized paragraph with no sentence breaks", () => {
    const text = "X".repeat(50000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20000);
  });
});

describe("averageVectors", () => {
  it("returns the input when given a single vector", () => {
    const v = [1, 2, 3];
    expect(averageVectors([v])).toBe(v);
  });

  it("computes element-wise mean across vectors", () => {
    expect(averageVectors([[1, 2, 3], [3, 4, 5]])).toEqual([2, 3, 4]);
  });
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

  it("chunks an oversized entry and averages the vectors", async () => {
    const para = "A".repeat(15000);
    const longText = `${para}\n\n${para}`; // 30002 chars → 2 chunks
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, text: longText }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([
      [0.0, 0.25],
      [1.0, 0.75],
    ]);

    const result = await embedPending(mockPool);

    expect(result.entries).toBe(1);
    expect(result.skipped).toEqual([]);
    // Two chunks of the same paragraph go into the batch
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledWith([
      para,
      para,
    ]);
    // Stored vector is the average of the two
    const updateCall = mockPool.query.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("UPDATE entries SET embedding")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1][1][0]).toBe("[0.5,0.5]");
  });

  it("chunks an oversized artifact and stores a single averaged vector", async () => {
    const para = "B".repeat(15000);
    const body = `${para}\n\n${para}`;
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // entries
      .mockResolvedValueOnce({
        rows: [{ id: "art-001", title: "Big Review", body }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([
      [0.25, 0.5],
      [0.75, 0.5],
    ]);

    const result = await embedPending(mockPool);

    expect(result.artifacts).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(mockEmbeddings.generateEmbeddingsBatch).toHaveBeenCalledTimes(1);
    const updateCall = mockPool.query.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("UPDATE knowledge_artifacts SET embedding")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1][1][0]).toBe("[0.5,0.5]");
  });

  it("skips items that exceed MAX_CHUNKS and reports them", async () => {
    // 250000 chars with no paragraph/sentence breaks → ~13 hard-slice chunks > MAX_CHUNKS=10
    const huge = "X".repeat(250000);
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, text: huge }] })
      // After id 1 is added to skip set, next query excludes it and returns []
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // artifacts done

    const result = await embedPending(mockPool);

    expect(result.entries).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      type: "entry",
      id: 1,
      chars: 250000,
    });
    expect(mockEmbeddings.generateEmbeddingsBatch).not.toHaveBeenCalled();
  });

  it("embeds normal items and chunks oversized in same batch", async () => {
    const para = "C".repeat(15000);
    const oversized = `${para}\n\n${para}`;
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // entries
      .mockResolvedValueOnce({
        rows: [
          { id: "art-001", title: "Small", body: "short body" },
          { id: "art-002", title: "Huge", body: oversized },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rows: [] }); // artifacts done

    mockEmbeddings.generateEmbeddingsBatch.mockResolvedValue([
      [0.1, 0.2], // small
      [0.0, 0.0], // huge chunk 1
      [1.0, 1.0], // huge chunk 2
    ]);

    const result = await embedPending(mockPool);

    expect(result.artifacts).toBe(2);
    expect(result.skipped).toEqual([]);
    // Single batch call: 1 input for the small artifact + 2 chunks for the huge one
    const calls = mockEmbeddings.generateEmbeddingsBatch.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toHaveLength(3);
    expect(calls[0][0][0]).toBe("Small\n\nshort body");
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
