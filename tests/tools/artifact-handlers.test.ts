import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArtifactRow, ArtifactSearchResultRow, UnifiedSearchResultRow } from "../../src/db/queries.js";

const mockQueries = vi.hoisted(() => ({
  getArtifactById: vi.fn(),
  listArtifacts: vi.fn(),
  searchArtifacts: vi.fn(),
  searchContent: vi.fn(),
}));

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);

import { handleGetArtifact } from "../../src/tools/get-artifact.js";
import { handleListArtifacts } from "../../src/tools/list-artifacts.js";
import { handleSearchArtifacts } from "../../src/tools/search-artifacts.js";
import { handleSearchContent } from "../../src/tools/search-content.js";

const mockPool = {} as any;

function makeArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "art-001",
    kind: "insight",
    title: "Test Artifact",
    body: "Test body content",
    tags: ["test"],
    has_embedding: true,
    created_at: new Date("2025-01-15T10:00:00Z"),
    updated_at: new Date("2025-01-15T10:00:00Z"),
    version: 1,
    source_entry_uuids: ["ENTRY-001"],
    ...overrides,
  };
}

function makeArtifactSearchResult(
  overrides: Partial<ArtifactSearchResultRow> = {}
): ArtifactSearchResultRow {
  return {
    id: "art-001",
    kind: "insight",
    title: "Test Artifact",
    body: "Test body content",
    tags: ["test"],
    has_embedding: true,
    rrf_score: 0.032,
    has_semantic: true,
    has_fulltext: false,
    created_at: new Date("2025-01-15T10:00:00Z"),
    updated_at: new Date("2025-01-15T10:00:00Z"),
    version: 1,
    ...overrides,
  };
}

function makeUnifiedResult(
  overrides: Partial<UnifiedSearchResultRow> = {}
): UnifiedSearchResultRow {
  return {
    content_type: "journal_entry",
    id: "ENTRY-001",
    title_or_label: "Barcelona",
    snippet: "Test snippet",
    rrf_score: 0.032,
    match_sources: ["semantic"],
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
  Object.values(mockEmbeddings).forEach((fn) => fn.mockReset());
});

describe("handleGetArtifact", () => {
  it("returns JSON artifact when found", async () => {
    mockQueries.getArtifactById.mockResolvedValue(makeArtifact());

    const result = await handleGetArtifact(mockPool, { id: "art-001" });
    const parsed = JSON.parse(result);

    expect(parsed).toMatchObject({
      id: "art-001",
      kind: "insight",
      title: "Test Artifact",
      has_embedding: true,
      source_entry_uuids: ["ENTRY-001"],
      version: 1,
    });
  });

  it("returns not found message when artifact is null", async () => {
    mockQueries.getArtifactById.mockResolvedValue(null);

    const result = await handleGetArtifact(mockPool, { id: "missing" });
    expect(result).toContain("No artifact found");
    expect(result).toContain("missing");
  });
});

describe("handleListArtifacts", () => {
  it("returns JSON array of artifacts", async () => {
    mockQueries.listArtifacts.mockResolvedValue([makeArtifact()]);

    const result = await handleListArtifacts(mockPool, {});
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "art-001" });
  });

  it("returns not found message for empty results", async () => {
    mockQueries.listArtifacts.mockResolvedValue([]);

    const result = await handleListArtifacts(mockPool, {});
    expect(result).toContain("No artifacts found");
  });

  it("passes filters correctly", async () => {
    mockQueries.listArtifacts.mockResolvedValue([makeArtifact()]);

    await handleListArtifacts(mockPool, {
      kind: "theory",
      tags: ["sleep"],
      tags_mode: "all",
      limit: 5,
      offset: 10,
    });

    expect(mockQueries.listArtifacts).toHaveBeenCalledWith(mockPool, {
      kind: "theory",
      tags: ["sleep"],
      tags_mode: "all",
      limit: 5,
      offset: 10,
    });
  });
});

describe("handleSearchArtifacts", () => {
  it("embeds query, searches, and returns JSON", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchArtifacts.mockResolvedValue([makeArtifactSearchResult()]);

    const result = await handleSearchArtifacts(mockPool, { query: "dopamine" });
    const parsed = JSON.parse(result);

    expect(mockEmbeddings.generateEmbedding).toHaveBeenCalledWith("dopamine");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "art-001",
      rrf_score: 0.032,
      match_sources: ["semantic"],
    });
  });

  it("returns not found for empty results", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchArtifacts.mockResolvedValue([]);

    const result = await handleSearchArtifacts(mockPool, { query: "test" });
    expect(result).toContain("No artifacts found");
  });

  it("includes fulltext in match_sources", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchArtifacts.mockResolvedValue([
      makeArtifactSearchResult({ has_semantic: false, has_fulltext: true }),
    ]);

    const result = await handleSearchArtifacts(mockPool, { query: "test" });
    const parsed = JSON.parse(result);
    expect(parsed[0].match_sources).toEqual(["fulltext"]);
  });
});

describe("handleSearchContent", () => {
  it("embeds query and returns unified results", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchContent.mockResolvedValue([
      makeUnifiedResult(),
      makeUnifiedResult({
        content_type: "knowledge_artifact",
        id: "art-001",
        title_or_label: "Dopamine Theory",
        match_sources: ["fulltext"],
      }),
    ]);

    const result = await handleSearchContent(mockPool, { query: "dopamine" });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].content_type).toBe("journal_entry");
    expect(parsed[1].content_type).toBe("knowledge_artifact");
  });

  it("returns not found for empty results", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchContent.mockResolvedValue([]);

    const result = await handleSearchContent(mockPool, { query: "test" });
    expect(result).toContain("No results found");
  });

  it("passes all filters to searchContent", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchContent.mockResolvedValue([]);

    await handleSearchContent(mockPool, {
      query: "test",
      content_types: ["knowledge_artifact"],
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      city: "Barcelona",
      entry_tags: ["health"],
      artifact_kind: "insight",
      artifact_tags: ["sleep"],
      limit: 20,
    });

    expect(mockQueries.searchContent).toHaveBeenCalledWith(
      mockPool,
      [0.1, 0.2],
      "test",
      {
        content_types: ["knowledge_artifact"],
        date_from: "2024-01-01",
        date_to: "2024-12-31",
        city: "Barcelona",
        entry_tags: ["health"],
        artifact_kind: "insight",
        artifact_tags: ["sleep"],
      },
      20
    );
  });
});
