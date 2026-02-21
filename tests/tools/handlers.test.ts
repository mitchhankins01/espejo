import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  EntryRow,
  SearchResultRow,
  SimilarResultRow,
  TagCountRow,
  EntryStatsRow,
} from "../../src/db/queries.js";

const mockQueries = vi.hoisted(() => ({
  searchEntries: vi.fn(),
  getEntryByUuid: vi.fn(),
  getEntriesByDateRange: vi.fn(),
  getEntriesOnThisDay: vi.fn(),
  findSimilarEntries: vi.fn(),
  listTags: vi.fn(),
  getEntryStats: vi.fn(),
}));

const mockEmbeddings = vi.hoisted(() => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);

import { handleSearchEntries } from "../../src/tools/search.js";
import { handleGetEntry } from "../../src/tools/get-entry.js";
import { handleGetEntriesByDate } from "../../src/tools/get-entries-by-date.js";
import { handleOnThisDay } from "../../src/tools/on-this-day.js";
import { handleFindSimilar } from "../../src/tools/find-similar.js";
import { handleListTags } from "../../src/tools/list-tags.js";
import { handleEntryStats } from "../../src/tools/entry-stats.js";

const mockPool = {} as any;

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    uuid: "TEST-UUID",
    text: "Test content",
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

function makeSearchResultRow(
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

function makeSimilarResultRow(
  overrides: Partial<SimilarResultRow> = {}
): SimilarResultRow {
  return {
    ...makeEntry(),
    similarity_score: 0.85,
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
  Object.values(mockEmbeddings).forEach((fn) => fn.mockReset());
});

describe("handleSearchEntries", () => {
  it("embeds query, searches, and returns JSON", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchEntries.mockResolvedValue([makeSearchResultRow()]);

    const result = await handleSearchEntries(mockPool, { query: "test" });
    const parsed = JSON.parse(result);

    expect(mockEmbeddings.generateEmbedding).toHaveBeenCalledWith("test");
    expect(mockQueries.searchEntries).toHaveBeenCalled();
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      uuid: "TEST-UUID",
      rrf_score: 0.032,
      match_sources: ["semantic"],
    });
  });

  it("returns plain text for empty results", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchEntries.mockResolvedValue([]);

    const result = await handleSearchEntries(mockPool, { query: "test" });
    expect(result).toContain("No results found");
  });
});

describe("handleGetEntry", () => {
  it("returns JSON entry when found", async () => {
    mockQueries.getEntryByUuid.mockResolvedValue(
      makeEntry({ city: "Barcelona", country: "Spain" })
    );

    const result = await handleGetEntry(mockPool, { uuid: "TEST-UUID" });
    const parsed = JSON.parse(result);

    expect(parsed).toMatchObject({
      uuid: "TEST-UUID",
      city: "Barcelona",
      country: "Spain",
      tags: [],
      media_counts: { photos: 0, videos: 0, audios: 0 },
    });
  });

  it("includes weight_kg when present", async () => {
    mockQueries.getEntryByUuid.mockResolvedValue(
      makeEntry({ weight_kg: 82.3 })
    );

    const result = await handleGetEntry(mockPool, { uuid: "TEST-UUID" });
    const parsed = JSON.parse(result);

    expect(parsed.weight_kg).toBe(82.3);
  });

  it("omits weight_kg when null", async () => {
    mockQueries.getEntryByUuid.mockResolvedValue(makeEntry());

    const result = await handleGetEntry(mockPool, { uuid: "TEST-UUID" });
    const parsed = JSON.parse(result);

    expect(parsed.weight_kg).toBeUndefined();
  });

  it("returns not found message when entry is null", async () => {
    mockQueries.getEntryByUuid.mockResolvedValue(null);

    const result = await handleGetEntry(mockPool, { uuid: "MISSING" });
    expect(result).toContain("No entry found");
    expect(result).toContain("MISSING");
  });
});

describe("handleGetEntriesByDate", () => {
  it("returns JSON array for date range", async () => {
    mockQueries.getEntriesByDateRange.mockResolvedValue([makeEntry()]);

    const result = await handleGetEntriesByDate(mockPool, {
      date_from: "2024-01-01",
      date_to: "2024-12-31",
    });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ uuid: "TEST-UUID" });
  });

  it("returns not found message for empty results", async () => {
    mockQueries.getEntriesByDateRange.mockResolvedValue([]);

    const result = await handleGetEntriesByDate(mockPool, {
      date_from: "2024-01-01",
      date_to: "2024-01-02",
    });
    expect(result).toContain("No entries found");
  });
});

describe("handleOnThisDay", () => {
  it("returns JSON array of entries", async () => {
    mockQueries.getEntriesOnThisDay.mockResolvedValue([makeEntry()]);

    const result = await handleOnThisDay(mockPool, { month_day: "03-15" });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ uuid: "TEST-UUID" });
  });

  it("returns not found for no entries", async () => {
    mockQueries.getEntriesOnThisDay.mockResolvedValue([]);

    const result = await handleOnThisDay(mockPool, { month_day: "02-29" });
    expect(result).toContain("No entries found");
  });

  it("handles multiple entries across years", async () => {
    mockQueries.getEntriesOnThisDay.mockResolvedValue([
      makeEntry({ created_at: new Date("2023-06-15") }),
      makeEntry({ created_at: new Date("2024-06-15") }),
    ]);

    const result = await handleOnThisDay(mockPool, { month_day: "06-15" });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
  });
});

describe("handleFindSimilar", () => {
  it("finds similar and returns JSON", async () => {
    mockQueries.findSimilarEntries.mockResolvedValue([makeSimilarResultRow()]);

    const result = await handleFindSimilar(mockPool, { uuid: "TEST" });
    const parsed = JSON.parse(result);

    expect(mockQueries.findSimilarEntries).toHaveBeenCalledWith(
      mockPool,
      "TEST",
      5
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      uuid: "TEST-UUID",
      similarity_score: 0.85,
    });
  });

  it("returns plain text for empty results", async () => {
    mockQueries.findSimilarEntries.mockResolvedValue([]);

    const result = await handleFindSimilar(mockPool, { uuid: "TEST" });
    expect(result).toContain("No similar entries found");
  });
});

describe("handleListTags", () => {
  it("returns JSON tag list", async () => {
    const tags: TagCountRow[] = [
      { name: "work", count: 10 },
      { name: "health", count: 5 },
    ];
    mockQueries.listTags.mockResolvedValue(tags);

    const result = await handleListTags(mockPool, {});
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ name: "work", count: 10 });
    expect(parsed[1]).toEqual({ name: "health", count: 5 });
  });

  it("returns message for no tags", async () => {
    mockQueries.listTags.mockResolvedValue([]);

    const result = await handleListTags(mockPool, {});
    expect(result).toContain("No tags found");
  });
});

describe("handleEntryStats", () => {
  const mockStats: EntryStatsRow = {
    total_entries: 100,
    first_entry: new Date("2023-01-01"),
    last_entry: new Date("2024-12-31"),
    avg_word_count: 250,
    total_word_count: 25000,
    entries_by_dow: { Monday: 20, Tuesday: 15 },
    entries_by_month: { January: 10, February: 8 },
    avg_entries_per_week: 3.5,
    longest_streak_days: 14,
    current_streak_days: 3,
  };

  it("returns JSON stats", async () => {
    mockQueries.getEntryStats.mockResolvedValue(mockStats);

    const result = await handleEntryStats(mockPool, {});
    const parsed = JSON.parse(result);

    expect(parsed).toMatchObject({
      total_entries: 100,
      avg_word_count: 250,
      total_word_count: 25000,
      longest_streak_days: 14,
      current_streak_days: 3,
      entries_by_day_of_week: { Monday: 20, Tuesday: 15 },
      entries_by_month: { January: 10, February: 8 },
      avg_entries_per_week: 3.5,
      date_range: {
        first: "2023-01-01T00:00:00.000Z",
        last: "2024-12-31T00:00:00.000Z",
      },
    });
  });

  it("returns message when no entries found", async () => {
    mockQueries.getEntryStats.mockResolvedValue({ total_entries: 0 });

    const result = await handleEntryStats(mockPool, {});
    expect(result).toContain("No entries found");
  });
});
