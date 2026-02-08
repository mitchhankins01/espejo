import { describe, it, expect } from "vitest";
import { pool } from "../../src/db/client.js";
import { fixtureEntries } from "../../specs/fixtures/seed.js";
import {
  expectSearchResults,
  expectRrfScore,
  expectEntryShape,
  expectSimilarityScore,
} from "../helpers/assertions.js";
import {
  searchEntries,
  getEntryByUuid,
  getEntriesByDateRange,
  getEntriesOnThisDay,
  findSimilarEntries,
  listTags,
  getEntryStats,
} from "../../src/db/queries.js";

// Use the work-stress embedding as a stand-in for query embedding in search tests
const workStressEntry = fixtureEntries.find(
  (e) => e.uuid === "ENTRY-001-WORK-STRESS"
)!;

describe("searchEntries", () => {
  it("returns results for a semantic query", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "feeling overwhelmed work stress",
      {},
      10
    );

    expectSearchResults(results, {
      query: "feeling overwhelmed work stress",
    });

    for (const r of results) {
      expectRrfScore(r.rrf_score, { query: "feeling overwhelmed work stress" });
    }
  });

  it("returns results in descending RRF score order", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "work deadline burnout",
      {},
      10
    );

    for (let i = 1; i < results.length; i++) {
      expect(results[i].rrf_score).toBeLessThanOrEqual(
        results[i - 1].rrf_score
      );
    }
  });

  it("filters by date range", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "work",
      { date_from: "2024-03-01", date_to: "2024-03-31" },
      10
    );

    for (const r of results) {
      const date = new Date(r.created_at);
      expect(date.getMonth()).toBe(2); // March (0-indexed)
      expect(date.getFullYear()).toBe(2024);
    }
  });

  it("filters by city", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "morning routine",
      { city: "San Diego" },
      10
    );

    for (const r of results) {
      expect(r.city).toBe("San Diego");
    }
  });

  it("filters by starred", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "feeling",
      { starred: true },
      10
    );

    for (const r of results) {
      expect(r.starred).toBe(true);
    }
  });

  it("filters by tags", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "review",
      { tags: ["travel"] },
      10
    );

    for (const r of results) {
      expect(r.tags.some((t: string) => t === "travel")).toBe(true);
    }
  });

  it("includes match source information", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "overwhelmed deadline",
      {},
      10
    );

    expectSearchResults(results, { query: "overwhelmed deadline" });
    // At least the first result should have a source
    expect(results[0].has_semantic || results[0].has_fulltext).toBe(true);
  });

  it("includes tags in results", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "overwhelmed",
      {},
      10
    );

    expectSearchResults(results, { query: "overwhelmed" });
    // Entry 001 has tags
    const entry001 = results.find((r) => r.uuid === "ENTRY-001-WORK-STRESS");
    if (entry001) {
      expect(entry001.tags.length).toBeGreaterThan(0);
    }
  });
});

describe("getEntryByUuid", () => {
  it("returns a full entry by UUID", async () => {
    const entry = await getEntryByUuid(pool, "ENTRY-001-WORK-STRESS");

    expect(entry).not.toBeNull();
    expectEntryShape(entry as Record<string, unknown>);
    expect(entry!.uuid).toBe("ENTRY-001-WORK-STRESS");
    expect(entry!.city).toBe("Barcelona");
    expect(entry!.starred).toBe(true);
    expect(entry!.tags).toContain("morning-review");
    expect(entry!.tags).toContain("work");
  });

  it("returns null for non-existent UUID", async () => {
    const entry = await getEntryByUuid(pool, "NONEXISTENT");
    expect(entry).toBeNull();
  });

  it("returns media counts", async () => {
    const entry = await getEntryByUuid(pool, "ENTRY-001-WORK-STRESS");
    expect(entry).not.toBeNull();
    expect(typeof entry!.photo_count).toBe("number");
    expect(typeof entry!.video_count).toBe("number");
    expect(typeof entry!.audio_count).toBe("number");
  });

  it("handles entry with no metadata", async () => {
    const entry = await getEntryByUuid(pool, "ENTRY-009-NO-METADATA");
    expect(entry).not.toBeNull();
    expect(entry!.city).toBeNull();
    expect(entry!.temperature).toBeNull();
    expect(entry!.tags).toEqual([]);
  });
});

describe("getEntriesByDateRange", () => {
  it("returns entries within date range", async () => {
    const entries = await getEntriesByDateRange(
      pool,
      "2024-03-01",
      "2024-03-31",
      20
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const date = new Date(entry.created_at);
      expect(date.getMonth()).toBe(2); // March
      expect(date.getFullYear()).toBe(2024);
    }
  });

  it("returns entries in chronological order", async () => {
    const entries = await getEntriesByDateRange(
      pool,
      "2024-01-01",
      "2024-12-31",
      50
    );

    for (let i = 1; i < entries.length; i++) {
      expect(new Date(entries[i].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(entries[i - 1].created_at).getTime()
      );
    }
  });

  it("returns empty array for no matches", async () => {
    const entries = await getEntriesByDateRange(
      pool,
      "2020-01-01",
      "2020-01-02",
      20
    );
    expect(entries).toEqual([]);
  });

  it("respects limit parameter", async () => {
    const entries = await getEntriesByDateRange(
      pool,
      "2024-01-01",
      "2025-12-31",
      2
    );
    expect(entries.length).toBeLessThanOrEqual(2);
  });
});

describe("getEntriesOnThisDay", () => {
  it("finds entries across years for June 15", async () => {
    // ENTRY-003 is 2024-06-15, ENTRY-004 is 2023-06-15
    const entries = await getEntriesOnThisDay(pool, 6, 15);

    expect(entries.length).toBe(2);
    const years = entries.map((e) => new Date(e.created_at).getFullYear());
    expect(years).toContain(2023);
    expect(years).toContain(2024);
  });

  it("returns entries in chronological order", async () => {
    const entries = await getEntriesOnThisDay(pool, 6, 15);

    for (let i = 1; i < entries.length; i++) {
      expect(new Date(entries[i].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(entries[i - 1].created_at).getTime()
      );
    }
  });

  it("returns empty for dates with no entries", async () => {
    const entries = await getEntriesOnThisDay(pool, 2, 29);
    expect(entries).toEqual([]);
  });
});

describe("findSimilarEntries", () => {
  it("returns similar entries excluding the source", async () => {
    const results = await findSimilarEntries(
      pool,
      "ENTRY-001-WORK-STRESS",
      5
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.uuid !== "ENTRY-001-WORK-STRESS")).toBe(true);
  });

  it("returns similarity scores in valid range", async () => {
    const results = await findSimilarEntries(
      pool,
      "ENTRY-001-WORK-STRESS",
      5
    );

    for (const r of results) {
      expectSimilarityScore(r.similarity_score, { uuid: r.uuid });
    }
  });

  it("ranks the most similar entry first", async () => {
    const results = await findSimilarEntries(
      pool,
      "ENTRY-001-WORK-STRESS",
      10
    );

    // ENTRY-002 shares the workStress base embedding with noise, should be most similar
    expect(results[0].uuid).toBe("ENTRY-002-WORK-BURNOUT");
  });

  it("respects limit", async () => {
    const results = await findSimilarEntries(
      pool,
      "ENTRY-001-WORK-STRESS",
      2
    );
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("listTags", () => {
  it("returns all tags with counts", async () => {
    const tags = await listTags(pool);

    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.name).toBeTruthy();
      expect(tag.count).toBeGreaterThan(0);
    }
  });

  it("orders by frequency descending", async () => {
    const tags = await listTags(pool);

    for (let i = 1; i < tags.length; i++) {
      expect(tags[i].count).toBeLessThanOrEqual(tags[i - 1].count);
    }
  });

  it("includes morning-review as most used tag", async () => {
    const tags = await listTags(pool);
    // morning-review appears in 6 entries
    expect(tags[0].name).toBe("morning-review");
  });
});

describe("getEntryStats", () => {
  it("returns stats for all entries", async () => {
    const stats = await getEntryStats(pool);

    expect(stats.total_entries).toBe(fixtureEntries.length);
    expect(stats.first_entry).toBeTruthy();
    expect(stats.last_entry).toBeTruthy();
    expect(stats.avg_word_count).toBeGreaterThan(0);
    expect(stats.total_word_count).toBeGreaterThan(0);
    expect(Object.keys(stats.entries_by_dow).length).toBeGreaterThan(0);
    expect(Object.keys(stats.entries_by_month).length).toBeGreaterThan(0);
  });

  it("filters by date range", async () => {
    const stats = await getEntryStats(pool, "2024-01-01", "2024-12-31");

    expect(stats.total_entries).toBeLessThan(fixtureEntries.length);
    expect(stats.total_entries).toBeGreaterThan(0);
  });

  it("returns zero streaks when no data in range", async () => {
    const stats = await getEntryStats(pool, "2020-01-01", "2020-01-02");
    expect(stats.total_entries).toBe(0);
  });
});
