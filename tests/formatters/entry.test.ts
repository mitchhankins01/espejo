import { describe, it, expect } from "vitest";
import { formatEntry, formatEntryList, getWordCount } from "../../src/formatters/entry.js";
import { toEntryResult, toEntryStats } from "../../src/formatters/mappers.js";
import type { EntryRow, EntryStatsRow } from "../../src/db/queries.js";

function makeEntry(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    uuid: "TEST-UUID",
    text: "This is a test entry with some content.",
    created_at: new Date("2024-03-15T09:30:00Z"),
    modified_at: null,
    timezone: "Europe/Madrid",
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

describe("formatEntry", () => {
  it("includes date", () => {
    const result = formatEntry(makeEntry());
    expect(result).toContain("March 15, 2024");
  });

  it("includes city and country when present", () => {
    const result = formatEntry(
      makeEntry({ city: "Barcelona", country: "Spain" })
    );
    expect(result).toContain("Barcelona, Spain");
  });

  it("includes tags when present", () => {
    const result = formatEntry(
      makeEntry({ tags: ["morning-review", "work"] })
    );
    expect(result).toContain("morning-review, work");
  });

  it("includes starred indicator", () => {
    const result = formatEntry(makeEntry({ starred: true }));
    expect(result).toContain("Starred");
  });

  it("does not include starred when false", () => {
    const result = formatEntry(makeEntry({ starred: false }));
    expect(result).not.toContain("Starred");
  });

  it("includes weather info", () => {
    const result = formatEntry(
      makeEntry({
        weather_conditions: "Partly Cloudy",
        temperature: 18,
      })
    );
    expect(result).toContain("Partly Cloudy");
    expect(result).toContain("18");
  });

  it("includes place name", () => {
    const result = formatEntry(makeEntry({ place_name: "Eixample" }));
    expect(result).toContain("Eixample");
  });

  it("includes entry text", () => {
    const result = formatEntry(makeEntry());
    expect(result).toContain("This is a test entry");
  });

  it("includes UUID", () => {
    const result = formatEntry(makeEntry());
    expect(result).toContain("TEST-UUID");
  });

  it("includes template name when present", () => {
    const result = formatEntry(makeEntry({ template_name: "5 Minute AM" }));
    expect(result).toContain("5 Minute AM");
  });

  it("includes media counts when present", () => {
    const result = formatEntry(makeEntry({ photo_count: 3, video_count: 1 }));
    expect(result).toContain("3 photos");
    expect(result).toContain("1 video");
  });

  it("uses singular photo and plural videos", () => {
    const result = formatEntry(makeEntry({ photo_count: 1, video_count: 2 }));
    expect(result).toContain("1 photo");
    expect(result).not.toContain("1 photos");
    expect(result).toContain("2 videos");
  });

  it("includes activity info when present", () => {
    const result = formatEntry(
      makeEntry({ user_activity: "Walking", step_count: 5000 })
    );
    expect(result).toContain("Walking");
    expect(result).toContain("steps");
  });

  it("includes step count only when activity is null", () => {
    const result = formatEntry(makeEntry({ step_count: 3000 }));
    expect(result).toContain("steps");
  });

  it("includes media URLs when present", () => {
    const result = formatEntry(
      makeEntry({
        photo_count: 2,
        media: [
          { type: "photo", url: "https://r2.dev/photos/a.jpeg", dimensions: null },
          { type: "video", url: "https://r2.dev/videos/b.mov", dimensions: null },
          { type: "audio", url: "https://r2.dev/audios/c.m4a", dimensions: null },
        ],
      })
    );
    expect(result).toContain("https://r2.dev/photos/a.jpeg");
    expect(result).toContain("https://r2.dev/videos/b.mov");
    expect(result).toContain("https://r2.dev/audios/c.m4a");
  });

  it("includes audio count", () => {
    const result = formatEntry(makeEntry({ audio_count: 2 }));
    expect(result).toContain("2 audio");
  });

  it("handles minimal entry with no metadata", () => {
    const result = formatEntry(makeEntry());
    expect(result).toContain("March 15, 2024");
    expect(result).toContain("TEST-UUID");
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
  });
});

describe("formatEntryList", () => {
  it("returns message for empty list", () => {
    const result = formatEntryList([]);
    expect(result).toContain("No entries found");
  });

  it("separates multiple entries", () => {
    const entries = [makeEntry({ uuid: "A" }), makeEntry({ uuid: "B" })];
    const result = formatEntryList(entries);
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("===");
  });
});

describe("getWordCount", () => {
  it("counts words in text", () => {
    expect(getWordCount("hello world")).toBe(2);
  });

  it("returns 0 for null", () => {
    expect(getWordCount(null)).toBe(0);
  });

  it("handles multiple spaces", () => {
    expect(getWordCount("hello   world")).toBe(2);
  });
});

// ============================================================================
// Mapper tests
// ============================================================================

describe("toEntryResult", () => {
  it("maps basic fields and computes word_count", () => {
    const result = toEntryResult(makeEntry());
    expect(result).toMatchObject({
      uuid: "TEST-UUID",
      created_at: "2024-03-15T09:30:00.000Z",
      text: "This is a test entry with some content.",
      starred: false,
      is_pinned: false,
      tags: [],
      media_counts: { photos: 0, videos: 0, audios: 0 },
      word_count: 8,
    });
  });

  it("strips DB-only fields (id, modified_at, is_all_day, admin_area)", () => {
    const result = toEntryResult(makeEntry()) as Record<string, unknown>;
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("modified_at");
    expect(result).not.toHaveProperty("is_all_day");
    expect(result).not.toHaveProperty("admin_area");
  });

  it("includes optional location fields when present", () => {
    const result = toEntryResult(
      makeEntry({
        city: "Barcelona",
        country: "Spain",
        place_name: "Eixample",
        latitude: 41.39,
        longitude: 2.17,
        timezone: "Europe/Madrid",
      })
    );
    expect(result.city).toBe("Barcelona");
    expect(result.country).toBe("Spain");
    expect(result.place_name).toBe("Eixample");
    expect(result.latitude).toBe(41.39);
    expect(result.longitude).toBe(2.17);
    expect(result.timezone).toBe("Europe/Madrid");
  });

  it("omits optional fields when null", () => {
    const result = toEntryResult(makeEntry()) as Record<string, unknown>;
    expect(result).not.toHaveProperty("city");
    expect(result).not.toHaveProperty("country");
    expect(result).not.toHaveProperty("weather");
    expect(result).not.toHaveProperty("activity");
    expect(result).not.toHaveProperty("template_name");
    expect(result).not.toHaveProperty("editing_time");
  });

  it("nests weather object when weather fields are present", () => {
    const result = toEntryResult(
      makeEntry({
        temperature: 18,
        weather_conditions: "Partly Cloudy",
        humidity: 65,
      })
    );
    expect(result.weather).toEqual({
      temperature: 18,
      conditions: "Partly Cloudy",
      humidity: 65,
    });
  });

  it("nests activity object when activity fields are present", () => {
    const result = toEntryResult(
      makeEntry({ user_activity: "Walking", step_count: 5000 })
    );
    expect(result.activity).toEqual({
      name: "Walking",
      step_count: 5000,
    });
  });

  it("maps media counts correctly", () => {
    const result = toEntryResult(
      makeEntry({ photo_count: 3, video_count: 1, audio_count: 2 })
    );
    expect(result.media_counts).toEqual({
      photos: 3,
      videos: 1,
      audios: 2,
    });
  });

  it("includes template_name and editing_time when present", () => {
    const result = toEntryResult(
      makeEntry({ template_name: "5 Minute AM", editing_time: 120 })
    );
    expect(result.template_name).toBe("5 Minute AM");
    expect(result.editing_time).toBe(120);
  });
});

describe("toEntryStats", () => {
  it("maps all stats fields", () => {
    const row: EntryStatsRow = {
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

    const result = toEntryStats(row);
    expect(result).toEqual({
      total_entries: 100,
      date_range: {
        first: "2023-01-01T00:00:00.000Z",
        last: "2024-12-31T00:00:00.000Z",
      },
      avg_word_count: 250,
      total_word_count: 25000,
      entries_by_day_of_week: { Monday: 20, Tuesday: 15 },
      entries_by_month: { January: 10, February: 8 },
      avg_entries_per_week: 3.5,
      longest_streak_days: 14,
      current_streak_days: 3,
    });
  });
});
