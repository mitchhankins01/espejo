import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  createEntry: vi.fn(),
  updateEntryEmbeddingIfVersionMatches: vi.fn(),
}));

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);

import { handleCreateEntry } from "../../src/tools/create-entry.js";
import { validateToolInput, toolSpecs } from "../../specs/tools.spec.js";

const mockPool = {} as any;

beforeEach(() => {
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
  Object.values(mockEmbeddings).forEach((fn) => fn.mockReset());
});

describe("create_entry spec", () => {
  it("validates minimal input", () => {
    const result = validateToolInput("create_entry", { text: "Hello" });
    expect(result.text).toBe("Hello");
  });

  it("validates all fields", () => {
    const result = validateToolInput("create_entry", {
      text: "Hello",
      tags: ["morning-journal"],
      date: "2026-03-09",
      timezone: "Europe/Madrid",
      source: "telegram",
      city: "Barcelona",
    });
    expect(result.source).toBe("telegram");
    expect(result.tags).toEqual(["morning-journal"]);
  });

  it("defaults source to mcp", () => {
    const result = validateToolInput("create_entry", { text: "Hello" });
    expect(result.source).toBe("mcp");
  });

  it("rejects empty text", () => {
    expect(() => validateToolInput("create_entry", { text: "" })).toThrow();
  });

  it("rejects missing text", () => {
    expect(() => validateToolInput("create_entry", {})).toThrow();
  });

  it("rejects invalid source", () => {
    expect(() =>
      validateToolInput("create_entry", { text: "Hi", source: "invalid" })
    ).toThrow();
  });

  it("has correct tool name", () => {
    expect(toolSpecs.create_entry.name).toBe("create_entry");
  });
});

describe("handleCreateEntry", () => {
  it("creates entry and returns uuid + created_at", async () => {
    const createdAt = new Date("2026-03-09T10:00:00Z");
    mockQueries.createEntry.mockResolvedValue({
      uuid: "test-uuid-123",
      created_at: createdAt,
      text: "Morning reflection",
      version: 1,
    });
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.updateEntryEmbeddingIfVersionMatches.mockResolvedValue(true);

    const result = await handleCreateEntry(mockPool, {
      text: "Morning reflection",
      tags: ["morning-journal"],
    });
    const parsed = JSON.parse(result);

    expect(parsed.uuid).toBe("test-uuid-123");
    expect(parsed.created_at).toBe(createdAt.toISOString());
    expect(mockQueries.createEntry).toHaveBeenCalledWith(mockPool, {
      text: "Morning reflection",
      tags: ["morning-journal"],
      timezone: undefined,
      created_at: undefined,
      city: undefined,
      source: "mcp",
    });
  });

  it("passes source through to createEntry", async () => {
    mockQueries.createEntry.mockResolvedValue({
      uuid: "tg-uuid",
      created_at: new Date(),
      text: "From telegram",
      version: 1,
    });
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1]);
    mockQueries.updateEntryEmbeddingIfVersionMatches.mockResolvedValue(true);

    await handleCreateEntry(mockPool, {
      text: "From telegram",
      source: "telegram",
    });

    expect(mockQueries.createEntry).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({ source: "telegram" })
    );
  });

  it("fires embedding generation", async () => {
    mockQueries.createEntry.mockResolvedValue({
      uuid: "emb-uuid",
      created_at: new Date(),
      text: "Generate my embedding",
      version: 1,
    });
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.5]);
    mockQueries.updateEntryEmbeddingIfVersionMatches.mockResolvedValue(true);

    await handleCreateEntry(mockPool, { text: "Generate my embedding" });

    // Wait for fire-and-forget promise
    await new Promise((r) => setTimeout(r, 10));

    expect(mockEmbeddings.generateEmbedding).toHaveBeenCalledWith(
      "Generate my embedding"
    );
  });
});
