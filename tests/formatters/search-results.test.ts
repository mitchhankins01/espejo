import { describe, it, expect } from "vitest";
import {
  formatSearchResults,
  formatSimilarResults,
} from "../../src/formatters/search-results.js";
import { toSearchResult, toSimilarResult, toTagCount } from "../../src/formatters/mappers.js";
import type { EntryRow, SearchResultRow, SimilarResultRow, TagCountRow } from "../../src/db/queries.js";

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    uuid: "TEST-UUID",
    text: "This is a preview of the entry content...",
    created_at: new Date("2024-03-15T09:30:00Z"),
    modified_at: null,
    timezone: null,
    city: null,
    country: null,
    place_name: null,
    admin_area: null,
    latitude: null,
    longitude: null,
    temperature: null,
    weather_conditions: null,
    humidity: null,
    tags: [],
    photo_count: 0,
    video_count: 0,
    audio_count: 0,
    media: [],
    weight_kg: null,
    ...overrides,
  };
}

function makeSearchResult(
  overrides: Partial<SearchResultRow> = {}
): SearchResultRow {
  return {
    ...makeEntry(),
    rrf_score: 0.032,
    has_semantic: true,
    has_fulltext: false,
    ...overrides,
  };
}

function makeSimilarResult(
  overrides: Partial<SimilarResultRow> = {}
): SimilarResultRow {
  return {
    ...makeEntry({ text: "This is a preview..." }),
    similarity_score: 0.85,
    ...overrides,
  };
}

describe("formatSearchResults", () => {
  it("returns message for empty results", () => {
    const result = formatSearchResults([]);
    expect(result).toContain("No results found");
  });

  it("includes result count", () => {
    const result = formatSearchResults([makeSearchResult()]);
    expect(result).toContain("1 result");
  });

  it("shows rank number", () => {
    const result = formatSearchResults([
      makeSearchResult({ uuid: "A" }),
      makeSearchResult({ uuid: "B" }),
    ]);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
  });

  it("shows date", () => {
    const result = formatSearchResults([makeSearchResult()]);
    expect(result).toContain("Mar 15, 2024");
  });

  it("shows city when present", () => {
    const result = formatSearchResults([
      makeSearchResult({ city: "Barcelona" }),
    ]);
    expect(result).toContain("Barcelona");
  });

  it("shows RRF score", () => {
    const result = formatSearchResults([
      makeSearchResult({ rrf_score: 0.032 }),
    ]);
    expect(result).toContain("0.0320");
  });

  it("shows match sources", () => {
    const result = formatSearchResults([
      makeSearchResult({ has_semantic: true, has_fulltext: true }),
    ]);
    expect(result).toContain("semantic");
    expect(result).toContain("keyword");
  });

  it("shows UUID", () => {
    const result = formatSearchResults([makeSearchResult()]);
    expect(result).toContain("TEST-UUID");
  });

  it("shows tags when present", () => {
    const result = formatSearchResults([
      makeSearchResult({ tags: ["work", "health"] }),
    ]);
    expect(result).toContain("work, health");
  });

  it("truncates long text in preview", () => {
    const longText = "a".repeat(300);
    const result = formatSearchResults([
      makeSearchResult({ text: longText }),
    ]);
    expect(result).toContain("...");
  });

  it("handles null text", () => {
    const result = formatSearchResults([
      makeSearchResult({ text: null as unknown as string }),
    ]);
    expect(result).toContain("TEST-UUID");
  });
});

describe("formatSimilarResults", () => {
  it("returns message for empty results", () => {
    const result = formatSimilarResults([]);
    expect(result).toContain("No similar entries found");
  });

  it("includes similarity percentage", () => {
    const result = formatSimilarResults([
      makeSimilarResult({ similarity_score: 0.85 }),
    ]);
    expect(result).toContain("85.0%");
  });

  it("includes UUID", () => {
    const result = formatSimilarResults([makeSimilarResult()]);
    expect(result).toContain("TEST-UUID");
  });

  it("shows tags when present", () => {
    const result = formatSimilarResults([
      makeSimilarResult({ tags: ["work", "health"] }),
    ]);
    expect(result).toContain("work, health");
  });

  it("shows city when present", () => {
    const result = formatSimilarResults([
      makeSimilarResult({ city: "Barcelona" }),
    ]);
    expect(result).toContain("Barcelona");
  });

  it("truncates long text in preview", () => {
    const longText = "a".repeat(300);
    const result = formatSimilarResults([
      makeSimilarResult({ text: longText }),
    ]);
    expect(result).toContain("...");
  });

  it("uses singular for single result", () => {
    const result = formatSimilarResults([makeSimilarResult()]);
    expect(result).toContain("1 similar entry");
  });

  it("uses plural for multiple results", () => {
    const result = formatSimilarResults([
      makeSimilarResult({ uuid: "A" }),
      makeSimilarResult({ uuid: "B" }),
    ]);
    expect(result).toContain("2 similar entries");
  });

  it("handles null text", () => {
    const result = formatSimilarResults([
      makeSimilarResult({ text: null as unknown as string }),
    ]);
    expect(result).toContain("TEST-UUID");
  });
});

// ============================================================================
// Mapper tests
// ============================================================================

describe("toSearchResult", () => {
  it("maps basic fields and converts date to ISO string", () => {
    const result = toSearchResult(makeSearchResult());
    expect(result).toMatchObject({
      uuid: "TEST-UUID",
      created_at: "2024-03-15T09:30:00.000Z",
      text: "This is a preview of the entry content...",
      tags: [],
      rrf_score: 0.032,
      media_counts: { photos: 0, videos: 0, audios: 0 },
    });
  });

  it("maps has_semantic/has_fulltext to match_sources array", () => {
    const both = toSearchResult(
      makeSearchResult({ has_semantic: true, has_fulltext: true })
    );
    expect(both.match_sources).toEqual(["semantic", "fulltext"]);

    const semanticOnly = toSearchResult(
      makeSearchResult({ has_semantic: true, has_fulltext: false })
    );
    expect(semanticOnly.match_sources).toEqual(["semantic"]);

    const fulltextOnly = toSearchResult(
      makeSearchResult({ has_semantic: false, has_fulltext: true })
    );
    expect(fulltextOnly.match_sources).toEqual(["fulltext"]);
  });

  it("includes city when present", () => {
    const result = toSearchResult(makeSearchResult({ city: "Barcelona" }));
    expect(result.city).toBe("Barcelona");
  });

  it("omits city when null", () => {
    const result = toSearchResult(makeSearchResult()) as Record<string, unknown>;
    expect(result).not.toHaveProperty("city");
  });

  it("strips DB-only fields (id)", () => {
    const result = toSearchResult(makeSearchResult()) as Record<string, unknown>;
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("has_semantic");
    expect(result).not.toHaveProperty("has_fulltext");
  });
});

describe("toSimilarResult", () => {
  it("maps basic fields", () => {
    const result = toSimilarResult(makeSimilarResult());
    expect(result).toMatchObject({
      uuid: "TEST-UUID",
      created_at: "2024-03-15T09:30:00.000Z",
      text: "This is a preview...",
      tags: [],
      similarity_score: 0.85,
      media_counts: { photos: 0, videos: 0, audios: 0 },
    });
  });

  it("includes city when present", () => {
    const result = toSimilarResult(makeSimilarResult({ city: "Madrid" }));
    expect(result.city).toBe("Madrid");
  });

  it("omits city when null", () => {
    const result = toSimilarResult(makeSimilarResult()) as Record<string, unknown>;
    expect(result).not.toHaveProperty("city");
  });
});

describe("toTagCount", () => {
  it("maps name and count", () => {
    const row: TagCountRow = { name: "work", count: 42 };
    expect(toTagCount(row)).toEqual({ name: "work", count: 42 });
  });
});
