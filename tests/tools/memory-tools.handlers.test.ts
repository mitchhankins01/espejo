import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExtraction = vi.hoisted(() => ({
  rememberPattern: vi.fn(),
  extractPatternsFromChat: vi.fn(),
}));

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
}));

const mockQueries = vi.hoisted(() => ({
  searchPatternsHybrid: vi.fn(),
  getPatternStats: vi.fn(),
  getStalePatterns: vi.fn(),
  findSimilarPatternPairs: vi.fn(),
}));

const mockConsolidation = vi.hoisted(() => ({
  runMemoryConsolidation: vi.fn(),
}));

vi.mock("../../src/memory/extraction.js", () => mockExtraction);
vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);
vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/memory/consolidation.js", () => mockConsolidation);

import { handleRemember } from "../../src/tools/remember.js";
import { handleSaveChat } from "../../src/tools/save-chat.js";
import { handleRecall } from "../../src/tools/recall.js";
import { handleReflect } from "../../src/tools/reflect.js";

const pool = {} as any;

beforeEach(() => {
  Object.values(mockExtraction).forEach((fn) => fn.mockReset());
  Object.values(mockEmbeddings).forEach((fn) => fn.mockReset());
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
  Object.values(mockConsolidation).forEach((fn) => fn.mockReset());
});

describe("memory tool handlers", () => {
  it("remember stores a pattern", async () => {
    mockExtraction.rememberPattern.mockResolvedValue({
      action: "inserted",
      patternId: 42,
      similarity: undefined,
    });

    const text = await handleRemember(pool, {
      content: "Lives in Barcelona",
      kind: "identity",
    });

    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("inserted");
    expect(parsed.pattern_id).toBe(42);
  });

  it("save_chat extracts and persists patterns", async () => {
    mockExtraction.extractPatternsFromChat.mockResolvedValue([
      {
        content: "Lives in Barcelona",
        kind: "identity",
        confidence: 0.9,
        evidence: "User said it directly",
        signal: "explicit",
        entry_uuids: [],
      },
    ]);
    mockExtraction.rememberPattern.mockResolvedValue({
      action: "reinforced",
      patternId: 7,
      similarity: 0.9,
    });

    const text = await handleSaveChat(pool, {
      messages: "User: I live in Barcelona.",
    });

    const parsed = JSON.parse(text);
    expect(parsed.extracted).toBe(1);
    expect(parsed.reinforced).toBe(1);
    expect(mockExtraction.rememberPattern).toHaveBeenCalledTimes(1);
  });

  it("recall returns filtered memories", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchPatternsHybrid.mockResolvedValue([
      {
        id: 1,
        kind: "identity",
        content: "Lives in Barcelona",
        confidence: 0.9,
        times_seen: 3,
        last_seen: new Date("2026-03-01T10:00:00Z"),
        score: 0.8,
      },
      {
        id: 2,
        kind: "goal",
        content: "Reach B2 Spanish",
        confidence: 0.8,
        times_seen: 2,
        last_seen: new Date("2026-03-02T10:00:00Z"),
        score: 0.7,
      },
    ]);

    const text = await handleRecall(pool, {
      query: "where do I live",
      kinds: ["identity"],
      limit: 5,
    });

    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("identity");
  });

  it("reflect stats returns stats payload", async () => {
    mockQueries.getPatternStats.mockResolvedValue({
      by_kind: { identity: 2 },
      by_status: { active: 2 },
      active_total: 2,
      avg_confidence: 0.9,
    });

    const text = await handleReflect(pool, { action: "stats" });
    const parsed = JSON.parse(text);
    expect(parsed.active_total).toBe(2);
  });

  it("reflect consolidate runs maintenance", async () => {
    mockQueries.findSimilarPatternPairs.mockResolvedValue([]);
    mockConsolidation.runMemoryConsolidation.mockResolvedValue({
      consolidated: 0,
      stale: 0,
      deprecatedForCap: 0,
      notes: [],
    });

    const text = await handleReflect(pool, { action: "consolidate" });
    const parsed = JSON.parse(text);
    expect(parsed.consolidation.deprecatedForCap).toBe(0);
  });
});
