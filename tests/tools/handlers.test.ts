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

const mockFormatters = vi.hoisted(() => ({
  formatEntry: vi.fn(),
  formatEntryList: vi.fn(),
  formatSearchResults: vi.fn(),
  formatSimilarResults: vi.fn(),
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/db/embeddings.js", () => mockEmbeddings);
vi.mock("../../src/formatters/entry.js", () => mockFormatters);
vi.mock("../../src/formatters/search-results.js", () => mockFormatters);

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
    starred: false,
    is_pinned: false,
    is_all_day: false,
    city: null,
    country: null,
    place_name: null,
    admin_area: null,
    latitude: null,
    longitude: null,
    temperature: null,
    weather_conditions: null,
    humidity: null,
    user_activity: null,
    step_count: null,
    template_name: null,
    editing_time: null,
    tags: [],
    photo_count: 0,
    video_count: 0,
    audio_count: 0,
    media: [],
    ...overrides,
  };
}

beforeEach(() => {
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
  Object.values(mockEmbeddings).forEach((fn) => fn.mockReset());
  Object.values(mockFormatters).forEach((fn) => fn.mockReset());
});

describe("handleSearchEntries", () => {
  it("embeds query, searches, and formats results", async () => {
    mockEmbeddings.generateEmbedding.mockResolvedValue([0.1, 0.2]);
    mockQueries.searchEntries.mockResolvedValue([]);
    mockFormatters.formatSearchResults.mockReturnValue("formatted");

    const result = await handleSearchEntries(mockPool, { query: "test" });

    expect(mockEmbeddings.generateEmbedding).toHaveBeenCalledWith("test");
    expect(mockQueries.searchEntries).toHaveBeenCalled();
    expect(result).toBe("formatted");
  });
});

describe("handleGetEntry", () => {
  it("returns formatted entry when found", async () => {
    mockQueries.getEntryByUuid.mockResolvedValue(makeEntry());
    mockFormatters.formatEntry.mockReturnValue("formatted entry");

    const result = await handleGetEntry(mockPool, { uuid: "TEST-UUID" });
    expect(result).toBe("formatted entry");
  });

  it("returns not found message when entry is null", async () => {
    mockQueries.getEntryByUuid.mockResolvedValue(null);

    const result = await handleGetEntry(mockPool, { uuid: "MISSING" });
    expect(result).toContain("No entry found");
    expect(result).toContain("MISSING");
  });
});

describe("handleGetEntriesByDate", () => {
  it("returns formatted entries for date range", async () => {
    mockQueries.getEntriesByDateRange.mockResolvedValue([makeEntry()]);
    mockFormatters.formatEntryList.mockReturnValue("formatted list");

    const result = await handleGetEntriesByDate(mockPool, {
      date_from: "2024-01-01",
      date_to: "2024-12-31",
    });
    expect(result).toBe("formatted list");
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
  it("returns formatted entries with header", async () => {
    mockQueries.getEntriesOnThisDay.mockResolvedValue([makeEntry()]);
    mockFormatters.formatEntryList.mockReturnValue("formatted list");

    const result = await handleOnThisDay(mockPool, { month_day: "03-15" });
    expect(result).toContain("1 entry");
    expect(result).toContain("formatted list");
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
    mockFormatters.formatEntryList.mockReturnValue("list");

    const result = await handleOnThisDay(mockPool, { month_day: "06-15" });
    expect(result).toContain("2 entries");
    expect(result).toContain("2 years");
  });
});

describe("handleFindSimilar", () => {
  it("finds similar and formats results", async () => {
    mockQueries.findSimilarEntries.mockResolvedValue([]);
    mockFormatters.formatSimilarResults.mockReturnValue("formatted");

    const result = await handleFindSimilar(mockPool, { uuid: "TEST" });
    expect(mockQueries.findSimilarEntries).toHaveBeenCalledWith(
      mockPool,
      "TEST",
      5
    );
    expect(result).toBe("formatted");
  });
});

describe("handleListTags", () => {
  it("returns formatted tag list", async () => {
    const tags: TagCountRow[] = [
      { name: "work", count: 10 },
      { name: "health", count: 5 },
    ];
    mockQueries.listTags.mockResolvedValue(tags);

    const result = await handleListTags(mockPool, {});
    expect(result).toContain("2 tags");
    expect(result).toContain("work");
    expect(result).toContain("10 entries");
    expect(result).toContain("health");
    expect(result).toContain("5 entries");
  });

  it("returns message for no tags", async () => {
    mockQueries.listTags.mockResolvedValue([]);

    const result = await handleListTags(mockPool, {});
    expect(result).toContain("No tags found");
  });

  it("uses singular for single entry count", async () => {
    mockQueries.listTags.mockResolvedValue([{ name: "rare", count: 1 }]);

    const result = await handleListTags(mockPool, {});
    expect(result).toContain("1 tag");
    expect(result).toContain("1 entry");
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

  it("returns formatted stats", async () => {
    mockQueries.getEntryStats.mockResolvedValue(mockStats);

    const result = await handleEntryStats(mockPool, {});
    expect(result).toContain("Journal Statistics");
    expect(result).toContain("100");
    expect(result).toContain("Word Counts");
    expect(result).toContain("25");
    expect(result).toContain("14 days");
    expect(result).toContain("3 days");
    expect(result).toContain("Monday");
    expect(result).toContain("January");
  });

  it("returns message when no entries found", async () => {
    mockQueries.getEntryStats.mockResolvedValue({ total_entries: 0 });

    const result = await handleEntryStats(mockPool, {});
    expect(result).toContain("No entries found");
  });

  it("includes date range in header when filters provided", async () => {
    mockQueries.getEntryStats.mockResolvedValue(mockStats);

    const result = await handleEntryStats(mockPool, {
      date_from: "2024-01-01",
      date_to: "2024-12-31",
    });
    expect(result).toContain("2024-01-01");
    expect(result).toContain("2024-12-31");
  });

  it("shows partial date range with start only", async () => {
    mockQueries.getEntryStats.mockResolvedValue(mockStats);

    const result = await handleEntryStats(mockPool, {
      date_from: "2024-01-01",
    });
    expect(result).toContain("2024-01-01");
    expect(result).toContain("now");
  });

  it("shows partial date range with end only", async () => {
    mockQueries.getEntryStats.mockResolvedValue(mockStats);

    const result = await handleEntryStats(mockPool, {
      date_to: "2024-12-31",
    });
    expect(result).toContain("start");
    expect(result).toContain("2024-12-31");
  });
});
