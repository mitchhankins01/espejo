import { describe, it, expect } from "vitest";
import {
  formatSearchResults,
  formatSimilarResults,
} from "../../src/formatters/search-results.js";
import type { SearchResultRow, SimilarResultRow } from "../../src/db/queries.js";

function makeSearchResult(
  overrides: Partial<SearchResultRow> = {}
): SearchResultRow {
  return {
    id: 1,
    uuid: "TEST-UUID",
    created_at: new Date("2024-03-15T09:30:00Z"),
    city: null,
    starred: false,
    preview: "This is a preview of the entry content...",
    tags: [],
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
    uuid: "TEST-UUID",
    created_at: new Date("2024-03-15T09:30:00Z"),
    preview: "This is a preview...",
    city: null,
    tags: [],
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

  it("shows starred indicator", () => {
    const result = formatSearchResults([
      makeSearchResult({ starred: true }),
    ]);
    expect(result).toContain("\u2B50");
  });

  it("truncates long previews", () => {
    const longText = "a".repeat(300);
    const result = formatSearchResults([
      makeSearchResult({ preview: longText }),
    ]);
    expect(result).toContain("...");
  });

  it("handles null preview", () => {
    const result = formatSearchResults([
      makeSearchResult({ preview: null as unknown as string }),
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

  it("truncates long previews", () => {
    const longText = "a".repeat(300);
    const result = formatSimilarResults([
      makeSimilarResult({ preview: longText }),
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

  it("handles null preview", () => {
    const result = formatSimilarResults([
      makeSimilarResult({ preview: null as unknown as string }),
    ]);
    expect(result).toContain("TEST-UUID");
  });
});
