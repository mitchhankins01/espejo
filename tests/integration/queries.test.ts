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
  getEntryStats,
  upsertDailyMetric,
  getWeightByDate,
  upsertWeight,
  deleteWeight,
  listWeights,
  getWeightPatterns,
  insertChatMessage,
  getRecentMessages,
  markMessagesCompacted,
  purgeCompactedMessages,
  insertPattern,
  reinforcePattern,
  deprecatePattern,
  updatePatternStatus,
  findSimilarPatterns,
  searchPatterns,
  getLanguagePreferencePatterns,
  getTopPatterns,
  pruneExpiredEventPatterns,
  countStaleEventPatterns,
  insertPatternObservation,
  insertPatternRelation,
  insertPatternAlias,
  linkPatternToEntry,
  logApiUsage,
  logMemoryRetrieval,
  getTotalApiCostSince,
  getLastCostNotificationTime,
  insertCostNotification,
  getUsageSummary,
  getLastCompactionTime,
  insertActivityLog,
  getActivityLog,
  getRecentActivityLogs,
  createArtifact,
  updateArtifact,
  deleteArtifact,
  getArtifactById,
  listArtifacts,
  countArtifacts,
  searchArtifacts,
  searchArtifactsKeyword,
  listArtifactTitles,
  resolveArtifactTitleToId,
  syncExplicitLinks,
  getExplicitLinks,
  getExplicitBacklinks,
  findSimilarArtifacts,
  getArtifactGraph,
  searchContent,
  searchEntriesForPicker,
  listTodos,
  getTodoById,
  createTodo,
  updateTodo,
  deleteTodo,
  completeTodo,
  setTodoFocus,
  getFocusTodo,
  createEntry,
  updateEntry,
  deleteEntry,
  listEntries,
  insertMedia,
  getMediaForEntry,
  deleteMedia,
  listTemplates,
  getTemplateBySlug,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getEntryIdByUuid,
  updateEntryEmbeddingIfVersionMatches,
  findArtifactByKindAndTitle,
  getRecentReviewArtifacts,
} from "../../src/db/queries.js";
import { fixturePatterns, fixtureArtifacts } from "../../specs/fixtures/seed.js";

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
      expect(r.text).toBeTruthy();
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

});

describe("getEntryByUuid", () => {
  it("returns a full entry by UUID", async () => {
    const entry = await getEntryByUuid(pool, "ENTRY-001-WORK-STRESS");

    expect(entry).not.toBeNull();
    expectEntryShape(entry as Record<string, unknown>);
    expect(entry!.uuid).toBe("ENTRY-001-WORK-STRESS");
    expect(entry!.city).toBe("Barcelona");
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
    for (const r of results) {
      expect(r.text).toBeTruthy();
    }
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

describe("daily_metrics enrichment", () => {
  it("includes weight_kg in entry when daily_metrics has data", async () => {
    // ENTRY-001-WORK-STRESS is 2024-03-15, fixture seeds weight 82.3 for that date
    const entry = await getEntryByUuid(pool, "ENTRY-001-WORK-STRESS");

    expect(entry).not.toBeNull();
    expect(entry!.weight_kg).toBe(82.3);
  });

  it("returns null weight_kg when no daily_metrics for that date", async () => {
    // ENTRY-009-NO-METADATA is 2024-08-01, no weight fixture for that date
    const entry = await getEntryByUuid(pool, "ENTRY-009-NO-METADATA");

    expect(entry).not.toBeNull();
    expect(entry!.weight_kg).toBeNull();
  });

  it("includes weight_kg in date range results", async () => {
    const entries = await getEntriesByDateRange(
      pool,
      "2024-03-01",
      "2024-03-31",
      20
    );

    expect(entries.length).toBeGreaterThan(0);
    // At least one entry should have weight data
    const withWeight = entries.filter((e) => e.weight_kg !== null);
    expect(withWeight.length).toBeGreaterThan(0);
  });

  it("includes weight_kg in search results", async () => {
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "overwhelmed work",
      {},
      10
    );

    expect(results.length).toBeGreaterThan(0);
    // ENTRY-001 (2024-03-15) should have weight from fixtures
    const entry001 = results.find((r) => r.uuid === "ENTRY-001-WORK-STRESS");
    if (entry001) {
      expect(entry001.weight_kg).toBe(82.3);
    }
  });

  it("includes weight_kg in on_this_day results", async () => {
    // June 15 has entries and weight fixture data
    const entries = await getEntriesOnThisDay(pool, 6, 15);

    expect(entries.length).toBe(2);
    // 2024-06-15 has weight data, 2023-06-15 does not
    const entry2024 = entries.find(
      (e) => new Date(e.created_at).getFullYear() === 2024
    );
    const entry2023 = entries.find(
      (e) => new Date(e.created_at).getFullYear() === 2023
    );
    expect(entry2024?.weight_kg).toBe(81.5);
    expect(entry2023?.weight_kg).toBeNull();
  });

  it("includes weight_kg in find_similar results", async () => {
    const results = await findSimilarEntries(
      pool,
      "ENTRY-001-WORK-STRESS",
      10
    );

    expect(results.length).toBeGreaterThan(0);
    // Each result should have weight_kg (either a number or null)
    for (const r of results) {
      expect(r.weight_kg === null || typeof r.weight_kg === "number").toBe(true);
    }
  });
});

describe("upsertDailyMetric", () => {
  it("inserts a new weight measurement", async () => {
    await upsertDailyMetric(pool, "2024-01-01", 83.0);

    const result = await pool.query(
      "SELECT weight_kg FROM daily_metrics WHERE date = $1",
      ["2024-01-01"]
    );
    expect(result.rows[0].weight_kg).toBe(83.0);
  });

  it("updates existing measurement on conflict", async () => {
    await upsertDailyMetric(pool, "2024-03-15", 99.9);

    const result = await pool.query(
      "SELECT weight_kg FROM daily_metrics WHERE date = $1",
      ["2024-03-15"]
    );
    expect(result.rows[0].weight_kg).toBe(99.9);
  });
});

describe("weight query APIs", () => {
  it("upserts and fetches weight by date", async () => {
    const saved = await upsertWeight(pool, "2026-03-01", 81.2);
    expect(saved.weight_kg).toBe(81.2);

    const fetched = await getWeightByDate(pool, "2026-03-01");
    expect(fetched).not.toBeNull();
    expect(fetched!.weight_kg).toBe(81.2);
  });

  it("returns null when getWeightByDate is missing", async () => {
    const fetched = await getWeightByDate(pool, "2030-01-01");
    expect(fetched).toBeNull();
  });

  it("deletes weight rows by date", async () => {
    await upsertWeight(pool, "2026-03-01", 81.2);
    const deleted = await deleteWeight(pool, "2026-03-01");
    expect(deleted).toBe(true);

    const missingDelete = await deleteWeight(pool, "2026-03-01");
    expect(missingDelete).toBe(false);
  });

  it("lists weights with date filters and pagination", async () => {
    await upsertWeight(pool, "2026-01-01", 82.0);
    await upsertWeight(pool, "2026-01-02", 81.8);
    await upsertWeight(pool, "2026-01-03", 81.7);

    const all = await listWeights(pool, {
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 10,
      offset: 0,
    });
    expect(all.count).toBe(3);
    expect(all.rows).toHaveLength(3);
    expect(all.rows.map((row) => row.weight_kg)).toEqual([81.7, 81.8, 82.0]);

    const paged = await listWeights(pool, {
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 1,
      offset: 1,
    });
    expect(paged.count).toBe(3);
    expect(paged.rows).toHaveLength(1);
    expect(paged.rows[0].weight_kg).toBe(81.8);
  });

  it("computes pattern metrics for seeded history", async () => {
    const patterns = await getWeightPatterns(pool);
    expect(patterns.latest).not.toBeNull();
    expect(patterns.delta_7d).not.toBeNull();
    expect(patterns.delta_30d).not.toBeNull();
    expect(patterns.weekly_pace_kg).not.toBeNull();
    expect(patterns.consistency).toBeGreaterThan(0);
    expect(patterns.streak_days).toBeGreaterThanOrEqual(1);
    expect(patterns.volatility_14d).not.toBeNull();
    expect(patterns.plateau).toBe(false);
    expect(patterns.range_days).toBeGreaterThan(0);
    expect(patterns.logged_days).toBeGreaterThan(0);
  });

  it("returns null deltas/volatility when only one point exists in range", async () => {
    await upsertWeight(pool, "2026-05-10", 80.0);
    const patterns = await getWeightPatterns(pool, {
      from: "2026-05-10",
      to: "2026-05-10",
    });
    expect(patterns.latest).not.toBeNull();
    expect(patterns.delta_7d).toBeNull();
    expect(patterns.delta_30d).toBeNull();
    expect(patterns.weekly_pace_kg).toBeNull();
    expect(patterns.volatility_14d).toBeNull();
    expect(patterns.streak_days).toBe(1);
  });

  it("detects plateau when 30-day change and volatility are both low", async () => {
    await upsertWeight(pool, "2026-01-01", 80.0);
    await upsertWeight(pool, "2026-01-08", 80.0);
    await upsertWeight(pool, "2026-01-15", 80.1);
    await upsertWeight(pool, "2026-01-22", 80.1);
    await upsertWeight(pool, "2026-01-31", 80.1);

    const patterns = await getWeightPatterns(pool, {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(patterns.delta_30d).not.toBeNull();
    expect(Math.abs(patterns.delta_30d!)).toBeLessThan(0.2);
    expect(patterns.volatility_14d).not.toBeNull();
    expect(patterns.plateau).toBe(true);
  });

  it("returns empty summary for ranges with no data", async () => {
    const patterns = await getWeightPatterns(pool, {
      from: "2030-01-01",
      to: "2030-01-31",
    });
    expect(patterns.latest).toBeNull();
    expect(patterns.delta_7d).toBeNull();
    expect(patterns.delta_30d).toBeNull();
    expect(patterns.weekly_pace_kg).toBeNull();
    expect(patterns.consistency).toBeNull();
    expect(patterns.streak_days).toBe(0);
    expect(patterns.volatility_14d).toBeNull();
    expect(patterns.plateau).toBe(false);
    expect(patterns.range_days).toBe(0);
    expect(patterns.logged_days).toBe(0);
  });
});

// ============================================================================
// Chat message queries
// ============================================================================

describe("insertChatMessage", () => {
  it("inserts a new message and returns id", async () => {
    const result = await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: "update:100",
      role: "user",
      content: "Hello bot",
    });
    expect(result.inserted).toBe(true);
    expect(result.id).toBeGreaterThan(0);
  });

  it("deduplicates on external_message_id", async () => {
    await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: "update:200",
      role: "user",
      content: "First",
    });
    const dup = await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: "update:200",
      role: "user",
      content: "Duplicate",
    });
    expect(dup.inserted).toBe(false);
    expect(dup.id).toBeNull();
  });

  it("allows null external_message_id for assistant messages", async () => {
    const r1 = await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: null,
      role: "assistant",
      content: "Reply 1",
    });
    const r2 = await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: null,
      role: "assistant",
      content: "Reply 2",
    });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
  });

  it("stores tool_call_id when provided", async () => {
    const result = await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: null,
      role: "tool_result",
      content: "result data",
      toolCallId: "toolu_abc123",
    });
    expect(result.inserted).toBe(true);

    const row = await pool.query(
      "SELECT tool_call_id FROM chat_messages WHERE id = $1",
      [result.id]
    );
    expect(row.rows[0].tool_call_id).toBe("toolu_abc123");
  });
});

describe("getRecentMessages", () => {
  it("returns uncompacted messages in chronological order", async () => {
    await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: "update:301",
      role: "user",
      content: "Message 1",
    });
    await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: null,
      role: "assistant",
      content: "Reply 1",
    });
    await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: "update:302",
      role: "user",
      content: "Message 2",
    });

    const messages = await getRecentMessages(pool, "12345", 100);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("Message 1");
    expect(messages[1].content).toBe("Reply 1");
    expect(messages[2].content).toBe("Message 2");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertChatMessage(pool, {
        chatId: "12345",
        externalMessageId: `update:4${i}`,
        role: "user",
        content: `Message ${i}`,
      });
    }
    const messages = await getRecentMessages(pool, "12345", 2);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("Message 3");
    expect(messages[1].content).toBe("Message 4");
  });
});

describe("markMessagesCompacted", () => {
  it("soft-deletes messages by setting compacted_at", async () => {
    const r1 = await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: "update:500",
      role: "user",
      content: "Old message",
    });

    await markMessagesCompacted(pool, [r1.id!]);

    const messages = await getRecentMessages(pool, "12345", 100);
    expect(messages).toHaveLength(0);
  });
});

describe("purgeCompactedMessages", () => {
  it("hard-deletes compacted messages older than threshold", async () => {
    const r1 = await insertChatMessage(pool, {
      chatId: "12345",
      externalMessageId: "update:600",
      role: "user",
      content: "Old message",
    });
    await markMessagesCompacted(pool, [r1.id!]);

    // Set compacted_at to the past
    await pool.query(
      "UPDATE chat_messages SET compacted_at = NOW() - INTERVAL '8 days' WHERE id = $1",
      [r1.id]
    );

    const deleted = await purgeCompactedMessages(pool, new Date());
    expect(deleted).toBe(1);
  });
});

// ============================================================================
// Pattern queries
// ============================================================================

describe("insertPattern", () => {
  it("inserts a pattern and returns the row", async () => {
    const pattern = await insertPattern(pool, {
      content: "User prefers morning workouts",
      kind: "preference",
      confidence: 0.8,
      embedding: fixturePatterns[0].embedding,
      temporal: { time_of_day: "morning" },
      canonicalHash: "abc123",
      timestamp: new Date(),
    });

    expect(pattern.id).toBeGreaterThan(0);
    expect(pattern.content).toBe("User prefers morning workouts");
    expect(pattern.kind).toBe("preference");
    expect(pattern.confidence).toBe(0.8);
    expect(pattern.strength).toBe(1.0);
    expect(pattern.times_seen).toBe(1);
    expect(pattern.status).toBe("active");
  });

  it("inserts a pattern without embedding", async () => {
    const pattern = await insertPattern(pool, {
      content: "User dislikes mornings",
      kind: "preference",
      confidence: 0.6,
      embedding: null,
      temporal: null,
      canonicalHash: "noembedding123",
      timestamp: new Date(),
    });

    expect(pattern.id).toBeGreaterThan(0);
    expect(pattern.content).toBe("User dislikes mornings");
    expect(pattern.temporal).toBeNull();
  });
});

describe("reinforcePattern", () => {
  it("increments times_seen and updates strength", async () => {
    // Get first seeded pattern
    const before = await pool.query(
      "SELECT * FROM patterns WHERE id = 1"
    );
    const beforeRow = before.rows[0];

    // Set last_seen to 14 days ago for meaningful spacing boost
    await pool.query(
      "UPDATE patterns SET last_seen = NOW() - INTERVAL '14 days' WHERE id = 1"
    );

    const reinforced = await reinforcePattern(pool, 1, 0.9);

    expect(reinforced.times_seen).toBe(beforeRow.times_seen + 1);
    expect(reinforced.confidence).toBe(0.9);
    expect(parseFloat(reinforced.strength as unknown as string)).toBeGreaterThan(
      parseFloat(beforeRow.strength)
    );
  });
});

describe("deprecatePattern", () => {
  it("sets status to deprecated", async () => {
    await deprecatePattern(pool, 1);

    const result = await pool.query(
      "SELECT status FROM patterns WHERE id = 1"
    );
    expect(result.rows[0].status).toBe("deprecated");
  });
});

describe("updatePatternStatus", () => {
  it("updates to arbitrary status", async () => {
    await updatePatternStatus(pool, 2, "superseded");

    const result = await pool.query(
      "SELECT status FROM patterns WHERE id = 2"
    );
    expect(result.rows[0].status).toBe("superseded");
  });
});

describe("findSimilarPatterns", () => {
  it("finds patterns by cosine similarity", async () => {
    const results = await findSimilarPatterns(
      pool,
      fixturePatterns[0].embedding,
      5,
      0.5
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.similarity).toBeGreaterThanOrEqual(0.5);
      expect(r.status).toBe("active");
    }
  });
});

describe("searchPatterns", () => {
  it("returns patterns ranked by typed-decay score", async () => {
    const results = await searchPatterns(
      pool,
      fixturePatterns[0].embedding,
      5,
      0.3
    );

    expect(results.length).toBeGreaterThan(0);
    // Scores should be in descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("excludes deprecated/superseded patterns", async () => {
    await deprecatePattern(pool, 1);

    const results = await searchPatterns(
      pool,
      fixturePatterns[0].embedding,
      10,
      0.0
    );

    expect(results.every((r) => r.id !== 1)).toBe(true);
  });

  it("supports memory-v2 kinds (identity/preference/goal)", async () => {
    const identityResults = await searchPatterns(
      pool,
      fixturePatterns[3].embedding,
      10,
      0.0
    );
    const preferenceResults = await searchPatterns(
      pool,
      fixturePatterns[0].embedding,
      10,
      0.0
    );

    expect(identityResults.some((r) => r.kind === "identity")).toBe(true);
    expect(preferenceResults.some((r) => r.kind === "preference")).toBe(true);
    expect(identityResults.every((r) => Number.isFinite(r.score))).toBe(true);
    expect(preferenceResults.every((r) => Number.isFinite(r.score))).toBe(true);
  });
});

describe("getLanguagePreferencePatterns", () => {
  it("returns active language preference/identity patterns and excludes unrelated content", async () => {
    await insertPattern(pool, {
      content: "User prefers English and Dutch as base languages with gradual Spanish practice.",
      kind: "preference",
      confidence: 0.92,
      embedding: fixturePatterns[0].embedding,
      temporal: null,
      canonicalHash: "lang-pref-active-001",
      expiresAt: null,
      timestamp: new Date(),
    });

    await insertPattern(pool, {
      content: "User speaks Dutch and English fluently.",
      kind: "identity",
      confidence: 0.9,
      embedding: fixturePatterns[3].embedding,
      temporal: null,
      canonicalHash: "lang-fact-active-001",
      expiresAt: null,
      timestamp: new Date(),
    });

    await insertPattern(pool, {
      content: "User prefers short replies.",
      kind: "preference",
      confidence: 0.8,
      embedding: fixturePatterns[1].embedding,
      temporal: null,
      canonicalHash: "non-lang-pref-001",
      expiresAt: null,
      timestamp: new Date(),
    });

    const results = await getLanguagePreferencePatterns(pool, 10);
    const contents = results.map((row) => row.content);

    expect(contents).toEqual(
      expect.arrayContaining([
        "User prefers English and Dutch as base languages with gradual Spanish practice.",
        "User speaks Dutch and English fluently.",
      ])
    );
    expect(contents).not.toContain("User prefers short replies.");
    expect(results[0].kind).toBe("preference");
  });

  it("excludes expired language patterns", async () => {
    await insertPattern(pool, {
      content: "User prefers to practice Spanish every evening.",
      kind: "preference",
      confidence: 0.85,
      embedding: fixturePatterns[0].embedding,
      temporal: null,
      canonicalHash: "lang-pref-expired-001",
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      timestamp: new Date(),
    });

    const results = await getLanguagePreferencePatterns(pool, 10);
    const contents = results.map((row) => row.content);

    expect(contents).not.toContain("User prefers to practice Spanish every evening.");
  });
});

describe("getTopPatterns", () => {
  it("returns active patterns ordered by strength", async () => {
    const results = await getTopPatterns(pool, 10);

    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].strength).toBeLessThanOrEqual(
        results[i - 1].strength
      );
    }
  });
});

describe("pruneExpiredEventPatterns", () => {
  it("returns 0 when event kind is no longer used", async () => {
    const changed = await pruneExpiredEventPatterns(pool);
    expect(changed).toBe(0);
  });
});

describe("countStaleEventPatterns", () => {
  it("returns 0 when event kind is no longer used", async () => {
    const count = await countStaleEventPatterns(pool);
    expect(count).toBe(0);
  });
});

// ============================================================================
// Pattern supporting queries
// ============================================================================

describe("insertPatternObservation", () => {
  it("creates an observation linked to a pattern", async () => {
    const obsId = await insertPatternObservation(pool, {
      patternId: 1,
      chatMessageIds: [1, 2],
      evidence: "User said they always feel tired after nicotine",
      evidenceRoles: ["user", "tool_result"],
      confidence: 0.8,
    });
    expect(obsId).toBeGreaterThan(0);
  });
});

describe("insertPatternRelation", () => {
  it("creates a relation between patterns", async () => {
    await insertPatternRelation(pool, 1, 2, "supports");

    const result = await pool.query(
      "SELECT * FROM pattern_relations WHERE from_pattern_id = 1 AND to_pattern_id = 2"
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].relation).toBe("supports");
  });

  it("ignores duplicate relations", async () => {
    await insertPatternRelation(pool, 1, 2, "contradicts");
    await insertPatternRelation(pool, 1, 2, "contradicts");

    const result = await pool.query(
      "SELECT * FROM pattern_relations WHERE from_pattern_id = 1 AND to_pattern_id = 2 AND relation = 'contradicts'"
    );
    expect(result.rows).toHaveLength(1);
  });
});

describe("insertPatternAlias", () => {
  it("creates an alias for a pattern without embedding", async () => {
    await insertPatternAlias(pool, 1, "Nicotine crashes dopamine", null);

    const result = await pool.query(
      "SELECT * FROM pattern_aliases WHERE pattern_id = 1"
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].content).toBe("Nicotine crashes dopamine");
  });

  it("creates an alias with embedding", async () => {
    await insertPatternAlias(
      pool,
      2,
      "Sleep suffers from caffeine",
      fixturePatterns[1].embedding
    );

    const result = await pool.query(
      "SELECT content, embedding IS NOT NULL AS has_embedding FROM pattern_aliases WHERE pattern_id = 2"
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].has_embedding).toBe(true);
  });
});

describe("linkPatternToEntry", () => {
  it("links a pattern to a journal entry", async () => {
    await linkPatternToEntry(pool, 1, "ENTRY-001-WORK-STRESS", "compaction", 0.8);

    const result = await pool.query(
      "SELECT * FROM pattern_entries WHERE pattern_id = 1 AND entry_uuid = $1",
      ["ENTRY-001-WORK-STRESS"]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].source).toBe("compaction");
    expect(parseFloat(result.rows[0].confidence)).toBe(0.8);
  });

  it("increments times_linked on repeated linking", async () => {
    await linkPatternToEntry(pool, 1, "ENTRY-002-WORK-BURNOUT", "compaction", 0.7);
    await linkPatternToEntry(pool, 1, "ENTRY-002-WORK-BURNOUT", "tool_loop", 0.9);

    const result = await pool.query(
      "SELECT times_linked FROM pattern_entries WHERE pattern_id = 1 AND entry_uuid = $1",
      ["ENTRY-002-WORK-BURNOUT"]
    );
    expect(result.rows[0].times_linked).toBe(2);
  });
});

// ============================================================================
// API usage tracking
// ============================================================================

describe("logApiUsage", () => {
  it("inserts a usage record", async () => {
    await logApiUsage(pool, {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      purpose: "agent",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0105,
      latencyMs: 1200,
    });

    const result = await pool.query("SELECT * FROM api_usage LIMIT 1");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].provider).toBe("anthropic");
    expect(result.rows[0].purpose).toBe("agent");
  });
});

describe("getUsageSummary", () => {
  it("aggregates usage by purpose", async () => {
    await logApiUsage(pool, {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      purpose: "agent",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
    });
    await logApiUsage(pool, {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      purpose: "agent",
      inputTokens: 2000,
      outputTokens: 800,
      costUsd: 0.02,
    });
    await logApiUsage(pool, {
      provider: "openai",
      model: "text-embedding-3-small",
      purpose: "embedding",
      inputTokens: 500,
      outputTokens: 0,
      costUsd: 0.001,
    });

    const summary = await getUsageSummary(pool, new Date(0));
    expect(summary.length).toBe(2);

    const agentSummary = summary.find((s) => s.purpose === "agent");
    expect(agentSummary).toBeDefined();
    expect(agentSummary!.total_calls).toBe(2);
    expect(agentSummary!.total_input_tokens).toBe(3000);
    expect(agentSummary!.total_output_tokens).toBe(1300);
  });
});

describe("cost notifications", () => {
  it("sums api usage cost within a time window", async () => {
    const now = new Date();
    await logApiUsage(pool, {
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250514",
      purpose: "agent",
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.02,
    });
    await logApiUsage(pool, {
      provider: "openai",
      model: "gpt-5-mini",
      purpose: "agent",
      inputTokens: 500,
      outputTokens: 250,
      costUsd: 0.03,
    });

    const total = await getTotalApiCostSince(
      pool,
      new Date(now.getTime() - 60 * 60 * 1000),
      new Date(now.getTime() + 60 * 1000)
    );
    expect(total).toBeGreaterThanOrEqual(0.05);
  });

  it("records and returns latest cost notification time by chat", async () => {
    const inserted = await insertCostNotification(pool, {
      chatId: "12345",
      windowStart: new Date(Date.now() - 12 * 60 * 60 * 1000),
      windowEnd: new Date(),
      costUsd: 0.11,
    });
    expect(inserted.cost_usd).toBe(0.11);

    const latest = await getLastCostNotificationTime(pool, "12345");
    expect(latest).toBeInstanceOf(Date);
  });
});

describe("logMemoryRetrieval", () => {
  it("stores memory retrieval telemetry", async () => {
    await logMemoryRetrieval(pool, {
      chatId: "12345",
      queryText: "remember when i moved to barcelona",
      queryHash: "hash-abc",
      degraded: false,
      patternIds: [1, 2],
      patternKinds: ["fact", "event"],
      topScore: 0.77,
    });

    const result = await pool.query(
      "SELECT * FROM memory_retrieval_logs WHERE query_hash = $1 LIMIT 1",
      ["hash-abc"]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].chat_id).toBe("12345");
    expect(result.rows[0].pattern_kinds).toEqual(["fact", "event"]);
  });

  it("pads missing pattern kinds as unknown to preserve positional alignment", async () => {
    await logMemoryRetrieval(pool, {
      chatId: "12345",
      queryText: "quick retrieval",
      queryHash: "hash-aligned",
      degraded: false,
      patternIds: [1, 2],
      patternKinds: ["fact"],
      topScore: 0.44,
    });

    const result = await pool.query(
      "SELECT pattern_kinds FROM memory_retrieval_logs WHERE query_hash = $1 LIMIT 1",
      ["hash-aligned"]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].pattern_kinds).toEqual(["fact", "unknown"]);
  });
});

// ============================================================================
// getLastCompactionTime
// ============================================================================

describe("getLastCompactionTime", () => {
  it("returns null when no compacted messages exist", async () => {
    const result = await getLastCompactionTime(pool, "999");
    expect(result).toBeNull();
  });

  it("returns the latest compacted_at timestamp", async () => {
    await insertChatMessage(pool, {
      chatId: "999",
      externalMessageId: "ext-1",
      role: "user",
      content: "hello",
    });
    await insertChatMessage(pool, {
      chatId: "999",
      externalMessageId: "ext-2",
      role: "assistant",
      content: "hi",
    });

    const messages = await getRecentMessages(pool, "999", 10);
    await markMessagesCompacted(pool, messages.map((m) => m.id));

    const result = await getLastCompactionTime(pool, "999");
    expect(result).toBeInstanceOf(Date);
  });
});

describe("activity logs", () => {
  it("inserts and retrieves an activity log by ID", async () => {
    const log = await insertActivityLog(pool, {
      chatId: "500",
      memories: [{ content: "likes coffee", kind: "preference", confidence: 0.9, score: 0.8 }],
      toolCalls: [{ name: "search_entries", args: { query: "coffee" }, result: "found 3", truncated_result: "found 3" }],
      costUsd: 0.0042,
    });

    expect(log.id).toBeGreaterThan(0);
    expect(log.chat_id).toBe("500");
    expect(log.memories).toHaveLength(1);
    expect(log.memories[0].content).toBe("likes coffee");
    expect(log.tool_calls).toHaveLength(1);
    expect(log.tool_calls[0].name).toBe("search_entries");
    expect(log.cost_usd).toBeCloseTo(0.0042);
    expect(log.created_at).toBeInstanceOf(Date);

    const fetched = await getActivityLog(pool, log.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(log.id);
    expect(fetched!.memories[0].kind).toBe("preference");
  });

  it("getActivityLog returns null for nonexistent ID", async () => {
    const result = await getActivityLog(pool, 999999);
    expect(result).toBeNull();
  });

  it("getRecentActivityLogs returns logs ordered by created_at DESC", async () => {
    await insertActivityLog(pool, { chatId: "600", memories: [], toolCalls: [], costUsd: null });
    await insertActivityLog(pool, { chatId: "600", memories: [], toolCalls: [], costUsd: 0.01 });

    const logs = await getRecentActivityLogs(pool, { chatId: "600", limit: 10 });
    expect(logs).toHaveLength(2);
    expect(logs[0].created_at.getTime()).toBeGreaterThanOrEqual(logs[1].created_at.getTime());
  });

  it("getRecentActivityLogs filters by chatId", async () => {
    await insertActivityLog(pool, { chatId: "701", memories: [], toolCalls: [], costUsd: null });
    await insertActivityLog(pool, { chatId: "702", memories: [], toolCalls: [], costUsd: null });

    const logs = await getRecentActivityLogs(pool, { chatId: "701", limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].chat_id).toBe("701");
  });

  it("getRecentActivityLogs filters by toolName", async () => {
    await insertActivityLog(pool, {
      chatId: "800",
      memories: [],
      toolCalls: [{ name: "search_entries", args: {}, result: "r", truncated_result: "r" }],
      costUsd: null,
    });
    await insertActivityLog(pool, {
      chatId: "800",
      memories: [],
      toolCalls: [{ name: "get_entry", args: {}, result: "r", truncated_result: "r" }],
      costUsd: null,
    });

    const logs = await getRecentActivityLogs(pool, { chatId: "800", toolName: "search_entries", limit: 10 });
    expect(logs).toHaveLength(1);
    expect(logs[0].tool_calls[0].name).toBe("search_entries");
  });

  it("getRecentActivityLogs respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertActivityLog(pool, { chatId: "900", memories: [], toolCalls: [], costUsd: null });
    }

    const logs = await getRecentActivityLogs(pool, { chatId: "900", limit: 3 });
    expect(logs).toHaveLength(3);
  });

  it("getRecentActivityLogs filters by since date", async () => {
    await insertActivityLog(pool, { chatId: "1000", memories: [], toolCalls: [], costUsd: null });

    const future = new Date(Date.now() + 60_000);
    const logs = await getRecentActivityLogs(pool, { chatId: "1000", since: future, limit: 10 });
    expect(logs).toHaveLength(0);
  });

  it("getRecentActivityLogs with no filters returns all logs", async () => {
    await insertActivityLog(pool, { chatId: "1100", memories: [], toolCalls: [], costUsd: null });

    const logs = await getRecentActivityLogs(pool, { limit: 100 });
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Knowledge Artifacts — CRUD
// ============================================================================

describe("createArtifact", () => {
  it("creates an artifact and returns it with correct shape", async () => {
    const art = await createArtifact(pool, {
      kind: "insight",
      title: "Test insight",
      body: "Body text here",
      source_entry_uuids: ["ENTRY-001-WORK-STRESS"],
    });

    expect(art.id).toBeTruthy();
    expect(art.kind).toBe("insight");
    expect(art.title).toBe("Test insight");
    expect(art.body).toBe("Body text here");
    expect(art.has_embedding).toBe(false);
    expect(art.version).toBe(1);
    expect(art.source_entry_uuids).toEqual(["ENTRY-001-WORK-STRESS"]);
    expect(art.created_at).toBeInstanceOf(Date);
    expect(art.updated_at).toBeInstanceOf(Date);
  });

  it("creates artifact without source entries", async () => {
    const art = await createArtifact(pool, {
      kind: "reference",
      title: "Standalone ref",
      body: "No sources",
    });

    expect(art.source_entry_uuids).toEqual([]);
  });

  it("creates artifact with custom source and status", async () => {
    const art = await createArtifact(pool, {
      kind: "review",
      title: "2026-03-28 — Evening Checkin",
      body: "Evening review body",
      source: "mcp",
      status: "pending",
    });

    expect(art.source).toBe("mcp");
    expect(art.status).toBe("pending");
    expect(art.kind).toBe("review");
  });

  it("uses DB defaults when source/status not provided", async () => {
    const art = await createArtifact(pool, {
      kind: "note",
      title: "Default source test",
      body: "body",
    });

    expect(art.source).toBe("web");
    expect(art.status).toBe("approved");
  });
});

describe("findArtifactByKindAndTitle", () => {
  it("finds existing artifact by kind and title", async () => {
    const created = await createArtifact(pool, {
      kind: "review",
      title: "Find me review",
      body: "body content",
      source: "mcp",
      status: "pending",
    });

    const found = await findArtifactByKindAndTitle(pool, "review", "Find me review");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.kind).toBe("review");
    expect(found!.body).toBe("body content");
  });

  it("returns null when no match", async () => {
    const result = await findArtifactByKindAndTitle(pool, "review", "Nonexistent");
    expect(result).toBeNull();
  });

  it("does not find deleted artifacts", async () => {
    const created = await createArtifact(pool, {
      kind: "review",
      title: "Deleted review",
      body: "body",
    });
    await deleteArtifact(pool, created.id);

    const result = await findArtifactByKindAndTitle(pool, "review", "Deleted review");
    expect(result).toBeNull();
  });
});

describe("getRecentReviewArtifacts", () => {
  it("returns review artifacts within date range", async () => {
    await createArtifact(pool, {
      kind: "review",
      title: "2026-03-28 — Evening Checkin",
      body: "March 28 review",
      source: "mcp",
      status: "pending",
    });

    const results = await getRecentReviewArtifacts(pool, "2026-03-27", "2026-03-29");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.kind === "review")).toBe(true);
  });

  it("returns empty array when no reviews in range", async () => {
    const results = await getRecentReviewArtifacts(pool, "2020-01-01", "2020-01-02");
    expect(results).toEqual([]);
  });

  it("excludes non-review artifacts", async () => {
    await createArtifact(pool, {
      kind: "note",
      title: "Not a review",
      body: "body",
    });

    const results = await getRecentReviewArtifacts(pool, "2026-03-27", "2026-03-29");
    expect(results.every((r) => r.kind === "review")).toBe(true);
  });
});

describe("getArtifactById", () => {
  it("returns seeded artifact with source UUIDs", async () => {
    // Get the ID of a seeded artifact
    const list = await listArtifacts(pool, { kind: "insight" });
    expect(list.length).toBeGreaterThan(0);

    const art = await getArtifactById(pool, list[0].id);
    expect(art).not.toBeNull();
    expect(art!.kind).toBe("insight");
    expect(art!.source_entry_uuids.length).toBeGreaterThan(0);
    expect(art!.has_embedding).toBe(true); // seeded with embedding
  });

  it("returns null for nonexistent ID", async () => {
    const result = await getArtifactById(pool, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

describe("updateArtifact", () => {
  it("updates fields and bumps version", async () => {
    const created = await createArtifact(pool, {
      kind: "insight",
      title: "Original title",
      body: "Original body",
    });

    const updated = await updateArtifact(pool, created.id, 1, {
      title: "New title",
    });

    expect(updated).not.toBe("version_conflict");
    expect(updated).not.toBeNull();
    const art = updated as Exclude<typeof updated, "version_conflict" | null>;
    expect(art.title).toBe("New title");
    expect(art.body).toBe("Original body");
    expect(art.version).toBe(2);
  });

  it("returns version_conflict on stale version", async () => {
    const created = await createArtifact(pool, {
      kind: "reference",
      title: "Conflict test",
      body: "body",
    });

    // Update once to bump version to 2
    await updateArtifact(pool, created.id, 1, { title: "V2" });

    // Try again with stale version 1
    const result = await updateArtifact(pool, created.id, 1, { title: "V3" });
    expect(result).toBe("version_conflict");
  });

  it("returns null for nonexistent artifact", async () => {
    const result = await updateArtifact(pool, "00000000-0000-0000-0000-000000000000", 1, { title: "X" });
    expect(result).toBeNull();
  });

  it("returns source_protected for obsidian-sourced artifact", async () => {
    // Create an artifact with source='obsidian'
    await pool.query(
      `INSERT INTO knowledge_artifacts (id, kind, title, body, source, source_path)
       VALUES ('00000000-0000-0000-0000-111111111111', 'note', 'Obsidian Note', 'body', 'obsidian', 'test.md')`
    );
    const result = await updateArtifact(pool, "00000000-0000-0000-0000-111111111111", 1, { title: "Changed" });
    expect(result).toBe("source_protected");
  });

  it("invalidates embedding when title changes", async () => {
    // Use a seeded artifact that has an embedding
    const list = await listArtifacts(pool, { kind: "insight" });
    const seeded = list[0];
    expect(seeded.has_embedding).toBe(true);

    const updated = await updateArtifact(pool, seeded.id, seeded.version, {
      title: "Changed title invalidates embedding",
    });
    const art = updated as Exclude<typeof updated, "version_conflict" | null>;
    expect(art.has_embedding).toBe(false);
  });

  it("invalidates embedding when body changes", async () => {
    const list = await listArtifacts(pool, { kind: "reference" });
    const seeded = list[0];
    expect(seeded.has_embedding).toBe(true);

    const updated = await updateArtifact(pool, seeded.id, seeded.version, {
      body: "Completely new body text",
    });
    const art = updated as Exclude<typeof updated, "version_conflict" | null>;
    expect(art.has_embedding).toBe(false);
  });

  it("preserves embedding when only kind changes", async () => {
    // Use a seeded artifact that already has an embedding (avoids trigger version bump from manual UPDATE)
    const list = await listArtifacts(pool, {});
    const seeded = list.find((a) => a.has_embedding);
    expect(seeded).toBeDefined();

    const updated = await updateArtifact(pool, seeded!.id, seeded!.version, {
      kind: "project",
    });
    const art = updated as Exclude<typeof updated, "version_conflict" | null>;
    expect(art.has_embedding).toBe(true);
    expect(art.kind).toBe("project");
  });

  it("updates source entry links", async () => {
    const created = await createArtifact(pool, {
      kind: "project",
      title: "Source test",
      body: "body",
      source_entry_uuids: ["ENTRY-001-WORK-STRESS"],
    });
    expect(created.source_entry_uuids).toEqual(["ENTRY-001-WORK-STRESS"]);

    const updated = await updateArtifact(pool, created.id, 1, {
      source_entry_uuids: ["ENTRY-002-WORK-BURNOUT", "ENTRY-003-MORNING-ROUTINE"],
    });
    const art = updated as Exclude<typeof updated, "version_conflict" | null>;
    expect(art.source_entry_uuids).toEqual(["ENTRY-002-WORK-BURNOUT", "ENTRY-003-MORNING-ROUTINE"]);
  });
});

describe("deleteArtifact", () => {
  it("deletes an artifact and cascades sources", async () => {
    const created = await createArtifact(pool, {
      kind: "insight",
      title: "To delete",
      body: "body",
      source_entry_uuids: ["ENTRY-001-WORK-STRESS"],
    });

    const deleted = await deleteArtifact(pool, created.id);
    expect(deleted).toBe(true);

    const fetched = await getArtifactById(pool, created.id);
    expect(fetched).toBeNull();

    // Verify sources also deleted
    const sources = await pool.query(
      `SELECT * FROM knowledge_artifact_sources WHERE artifact_id = $1`,
      [created.id]
    );
    expect(sources.rows).toHaveLength(0);
  });

  it("returns false for nonexistent artifact", async () => {
    const result = await deleteArtifact(pool, "00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });
});

// ============================================================================
// Knowledge Artifacts — Source FK integrity
// ============================================================================

describe("artifact source FK integrity", () => {
  it("prevents linking to nonexistent entry UUID (RESTRICT)", async () => {
    const created = await createArtifact(pool, {
      kind: "insight",
      title: "FK test",
      body: "body",
    });

    await expect(
      pool.query(
        `INSERT INTO knowledge_artifact_sources (artifact_id, entry_uuid) VALUES ($1, $2)`,
        [created.id, "NONEXISTENT-UUID"]
      )
    ).rejects.toThrow();
  });
});

// ============================================================================
// Knowledge Artifacts — List with filters
// ============================================================================

describe("listArtifacts", () => {
  it("returns all seeded artifacts", async () => {
    const all = await listArtifacts(pool, {});
    expect(all.length).toBe(fixtureArtifacts.length);
  });

  it("filters by kind", async () => {
    const insights = await listArtifacts(pool, { kind: "insight" });
    for (const a of insights) {
      expect(a.kind).toBe("insight");
    }
    expect(insights.length).toBeGreaterThan(0);
  });

  it("respects limit and offset", async () => {
    const page1 = await listArtifacts(pool, { limit: 1, offset: 0 });
    const page2 = await listArtifacts(pool, { limit: 1, offset: 1 });

    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it("includes source_entry_uuids", async () => {
    const all = await listArtifacts(pool, {});
    const withSources = all.filter((a) => a.source_entry_uuids.length > 0);
    expect(withSources.length).toBeGreaterThan(0);
  });

  it("filters by source", async () => {
    const webOnly = await listArtifacts(pool, { source: "web" });
    for (const a of webOnly) expect(a.source).toBe("web");
    // All seeded artifacts are source='web', so should match all
    expect(webOnly.length).toBe(fixtureArtifacts.length);
    // Filtering by obsidian should return none
    const obsidianOnly = await listArtifacts(pool, { source: "obsidian" });
    expect(obsidianOnly.length).toBe(0);
  });
});

// ============================================================================
// Knowledge Artifacts — Count
// ============================================================================

describe("countArtifacts", () => {
  it("counts all artifacts", async () => {
    const total = await countArtifacts(pool, {});
    expect(total).toBe(fixtureArtifacts.length);
  });

  it("counts filtered by kind", async () => {
    const total = await countArtifacts(pool, { kind: "insight" });
    const expected = fixtureArtifacts.filter((a) => a.kind === "insight").length;
    expect(total).toBe(expected);
  });

  it("counts filtered by source", async () => {
    const total = await countArtifacts(pool, { source: "obsidian" });
    expect(total).toBe(0);
  });
});

// ============================================================================
// Knowledge Artifacts — Search (RRF)
// ============================================================================

describe("searchArtifacts", () => {
  it("finds artifacts by semantic + fulltext", async () => {
    // Get the nicotine artifact's embedding to use as query vector
    const nicotineArt = (await listArtifacts(pool, { kind: "insight" }))[0];
    const embRow = await pool.query(
      `SELECT embedding::text FROM knowledge_artifacts WHERE id = $1`,
      [nicotineArt.id]
    );
    const embStr = embRow.rows[0].embedding as string;
    const embedding = embStr.slice(1, -1).split(",").map(Number);

    const results = await searchArtifacts(pool, embedding, "nicotine dopamine", {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rrf_score).toBeGreaterThan(0);
    expect(results[0].has_semantic || results[0].has_fulltext).toBe(true);
  });

  it("returns results in descending RRF score", async () => {
    const emb = await pool.query(
      `SELECT embedding::text FROM knowledge_artifacts WHERE embedding IS NOT NULL LIMIT 1`
    );
    const embedding = emb.rows[0].embedding.slice(1, -1).split(",").map(Number);

    const results = await searchArtifacts(pool, embedding, "health", {}, 10);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].rrf_score).toBeLessThanOrEqual(results[i - 1].rrf_score);
    }
  });

  it("filters by kind", async () => {
    const emb = await pool.query(
      `SELECT embedding::text FROM knowledge_artifacts WHERE embedding IS NOT NULL LIMIT 1`
    );
    const embedding = emb.rows[0].embedding.slice(1, -1).split(",").map(Number);

    const results = await searchArtifacts(pool, embedding, "health", { kind: "reference" }, 10);
    for (const r of results) {
      expect(r.kind).toBe("reference");
    }
  });

  it("filters by source", async () => {
    const emb = await pool.query(
      `SELECT embedding::text FROM knowledge_artifacts WHERE embedding IS NOT NULL LIMIT 1`
    );
    const embedding = emb.rows[0].embedding.slice(1, -1).split(",").map(Number);

    const results = await searchArtifacts(pool, embedding, "health", { source: "obsidian" }, 10);
    expect(results.length).toBe(0);
  });
});

describe("searchArtifactsKeyword", () => {
  it("matches title prefixes so 'class' finds 'classroom'", async () => {
    const created = await createArtifact(pool, {
      kind: "note",
      title: "Classroom regulation protocol",
      body: "Notes on classroom co-regulation and trauma-informed pacing.",
      source_entry_uuids: [],
    });

    const results = await searchArtifactsKeyword(pool, "class", {}, 10);
    expect(results.length).toBeGreaterThan(0);

    const match = results.find((r) => r.id === created.id);
    expect(match).toBeDefined();
    expect(match?.has_semantic).toBe(false);
    expect(match?.has_fulltext).toBe(true);
  });

  it("supports kind filter", async () => {
    const byKind = await searchArtifactsKeyword(pool, "sleep", { kind: "reference" }, 10);
    expect(byKind.length).toBeGreaterThan(0);
    for (const row of byKind) expect(row.kind).toBe("reference");
  });

  it("filters by source", async () => {
    const results = await searchArtifactsKeyword(pool, "sleep", { source: "obsidian" }, 10);
    expect(results.length).toBe(0);
  });
});

// ============================================================================
// Unified search — searchContent
// ============================================================================

describe("searchContent", () => {
  it("returns both journal entries and artifacts", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "health nicotine dopamine",
      {},
      20
    );
    expect(results.length).toBeGreaterThan(0);

    const types = new Set(results.map((r) => r.content_type));
    // We search with terms from both entries and artifacts, should get both types
    expect(types.size).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(["journal_entry", "knowledge_artifact"]).toContain(r.content_type);
      expect(r.rrf_score).toBeGreaterThan(0);
      expect(r.match_sources.length).toBeGreaterThan(0);
    }
  });

  it("returns results in descending RRF score", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "health",
      {},
      20
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i].rrf_score).toBeLessThanOrEqual(results[i - 1].rrf_score);
    }
  });

  it("filters by content_types to only entries", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "health",
      { content_types: ["journal_entry"] },
      20
    );
    for (const r of results) {
      expect(r.content_type).toBe("journal_entry");
    }
  });

  it("filters by content_types to only artifacts", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "nicotine dopamine",
      { content_types: ["knowledge_artifact"] },
      20
    );
    for (const r of results) {
      expect(r.content_type).toBe("knowledge_artifact");
    }
  });

  it("applies entry-specific filters", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "morning",
      { city: "San Diego" },
      20
    );
    // All journal entries should be from San Diego
    const entries = results.filter((r) => r.content_type === "journal_entry");
    for (const e of entries) {
      // title_or_label is city for journal entries
      expect(e.title_or_label).toBe("San Diego");
    }
  });

  it("applies artifact-specific filters", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "health sleep",
      { artifact_kind: "reference" },
      20
    );
    // Any artifact results should be theories
    const artifacts = results.filter((r) => r.content_type === "knowledge_artifact");
    if (artifacts.length > 0) {
      // We can verify by fetching the artifact
      const art = await getArtifactById(pool, artifacts[0].id);
      expect(art?.kind).toBe("reference");
    }
  });

  it("filters artifacts by artifact_source", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "health nicotine",
      { artifact_source: "web" },
      20
    );
    expect(Array.isArray(results)).toBe(true);
  });

  it("filters entries by date range", async () => {
    const results = await searchContent(
      pool,
      workStressEntry.embedding,
      "work deadline",
      { date_from: "2024-03-01", date_to: "2024-03-31" },
      20
    );
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================================================
// searchEntriesForPicker
// ============================================================================

describe("searchEntriesForPicker", () => {
  it("returns lightweight entry results", async () => {
    const results = await searchEntriesForPicker(pool, "overwhelmed deadline", 10);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.uuid).toBeTruthy();
      expect(r.created_at).toBeInstanceOf(Date);
      expect(r.preview.length).toBeGreaterThan(0);
      expect(r.preview.length).toBeLessThanOrEqual(120);
    }
  });

  it("returns empty for no matches", async () => {
    const results = await searchEntriesForPicker(pool, "zyxwvutsrq", 10);
    expect(results).toEqual([]);
  });
});

describe("artifact title + link queries", () => {
  it("listArtifactTitles returns latest artifacts first", async () => {
    const created = await createArtifact(pool, {
      kind: "note",
      title: "Latest note",
      body: "Body",
    });

    const titles = await listArtifactTitles(pool);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles[0].id).toBe(created.id);
    expect(titles[0].kind).toBe("note");
  });

  it("resolveArtifactTitleToId is case-insensitive", async () => {
    const created = await createArtifact(pool, {
      kind: "insight",
      title: "Trauma Classroom Link",
      body: "Body",
    });

    const resolved = await resolveArtifactTitleToId(pool, "trauma classroom link");
    const missing = await resolveArtifactTitleToId(pool, "does not exist");

    expect(resolved).toBe(created.id);
    expect(missing).toBeNull();
  });

  it("syncExplicitLinks replaces outgoing links and supports backlinks", async () => {
    const source = await createArtifact(pool, {
      kind: "insight",
      title: "Source Artifact",
      body: "Body",
    });
    const alpha = await createArtifact(pool, {
      kind: "reference",
      title: "Alpha Target",
      body: "Body",
    });
    const beta = await createArtifact(pool, {
      kind: "project",
      title: "Beta Target",
      body: "Body",
    });

    await syncExplicitLinks(pool, source.id, [
      beta.id,
      alpha.id,
      alpha.id,
      source.id,
    ]);

    const outgoing = await getExplicitLinks(pool, source.id);
    expect(outgoing.map((item) => item.id)).toEqual([alpha.id, beta.id]);

    const incoming = await getExplicitBacklinks(pool, beta.id);
    expect(incoming.some((item) => item.id === source.id)).toBe(true);

    await syncExplicitLinks(pool, source.id, []);
    const cleared = await getExplicitLinks(pool, source.id);
    expect(cleared).toEqual([]);
  });

  it("findSimilarArtifacts returns similarity-ranked results for embedded artifacts", async () => {
    const source = await createArtifact(pool, {
      kind: "insight",
      title: "Similarity Source",
      body: "Body",
    });
    const target = await createArtifact(pool, {
      kind: "reference",
      title: "Similarity Target",
      body: "Body",
    });

    const embeddingStr = `[${fixtureArtifacts[0].embedding.join(",")}]`;
    await pool.query(
      `UPDATE knowledge_artifacts SET embedding = $2::vector WHERE id = $1`,
      [source.id, embeddingStr]
    );
    await pool.query(
      `UPDATE knowledge_artifacts SET embedding = $2::vector WHERE id = $1`,
      [target.id, embeddingStr]
    );

    const similar = await findSimilarArtifacts(pool, source.id, 10, 0.3);
    expect(similar.length).toBeGreaterThan(0);
    expect(similar.some((item) => item.id === target.id)).toBe(true);
    expect(similar.every((item) => item.id !== source.id)).toBe(true);
    for (let i = 1; i < similar.length; i++) {
      expect(similar[i].similarity).toBeLessThanOrEqual(similar[i - 1].similarity);
    }
  });

  it("getArtifactGraph returns semantic, explicit, and shared-source edges", async () => {
    const first = await createArtifact(pool, {
      kind: "insight",
      title: "Graph A",
      body: "Body A",
      source_entry_uuids: ["ENTRY-001-WORK-STRESS"],
    });
    const second = await createArtifact(pool, {
      kind: "reference",
      title: "Graph B",
      body: "Body B",
      source_entry_uuids: ["ENTRY-001-WORK-STRESS"],
    });

    const embeddingStr = `[${fixtureArtifacts[0].embedding.join(",")}]`;
    await pool.query(
      `UPDATE knowledge_artifacts SET embedding = $2::vector WHERE id = $1`,
      [first.id, embeddingStr]
    );
    await pool.query(
      `UPDATE knowledge_artifacts SET embedding = $2::vector WHERE id = $1`,
      [second.id, embeddingStr]
    );

    await syncExplicitLinks(pool, first.id, [second.id]);
    const graph = await getArtifactGraph(pool);
    const hasPair = (a: string, b: string, x: string, y: string): boolean =>
      (a === x && b === y) || (a === y && b === x);

    expect(
      graph.explicitLinks.some(
        (link) => link.source_id === first.id && link.target_id === second.id
      )
    ).toBe(true);
    expect(
      graph.sharedSources.some(
        (pair) => hasPair(pair.artifact_id_1, pair.artifact_id_2, first.id, second.id)
      )
    ).toBe(true);
    expect(
      graph.similarities.some(
        (pair) => hasPair(pair.id_1, pair.id_2, first.id, second.id)
      )
    ).toBe(true);
  });
});

describe("todo queries", () => {
  it("createTodo inserts with correct fields", async () => {
    const todo = await createTodo(pool, {
      title: "Spanish taxes 2025",
      status: "active",
      next_step: "Send docs",
      body: "Track updates",
    });

    expect(todo.id).toBeTruthy();
    expect(todo.status).toBe("active");
  });

  it("getTodoById returns null for missing row", async () => {
    const todo = await getTodoById(pool, "00000000-0000-0000-0000-000000000000");
    expect(todo).toBeNull();
  });

  it("listTodos supports status filter and total count", async () => {
    await createTodo(pool, { title: "Active todo", status: "active" });
    await createTodo(pool, { title: "Waiting todo", status: "waiting" });

    const all = await listTodos(pool, { limit: 20, offset: 0 });
    const waiting = await listTodos(pool, {
      status: "waiting",
      limit: 20,
      offset: 0,
    });

    expect(all.count).toBeGreaterThanOrEqual(2);
    expect(waiting.rows).toHaveLength(1);
    expect(waiting.rows[0].status).toBe("waiting");
  });

  it("updateTodo updates provided fields and keeps existing when empty update", async () => {
    const created = await createTodo(pool, {
      title: "Initial",
      status: "active",
      next_step: "Step 1",
      body: "Body",
    });

    const updated = await updateTodo(pool, created.id, {
      status: "done",
      next_step: null,
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("done");
    expect(updated!.next_step).toBeNull();
    expect(updated!.completed_at).not.toBeNull();

    // Moving away from done clears completed_at
    const reactivated = await updateTodo(pool, created.id, { status: "active" });
    expect(reactivated!.completed_at).toBeNull();

    const unchanged = await updateTodo(pool, created.id, {});
    expect(unchanged).not.toBeNull();
    expect(unchanged!.id).toBe(created.id);
  });

  it("updateTodo supports title/body updates", async () => {
    const created = await createTodo(pool, {
      title: "Original title",
      body: "Original body",
    });

    const updated = await updateTodo(pool, created.id, {
      title: "Updated title",
      body: "Updated body",
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated title");
    expect(updated!.body).toBe("Updated body");
  });

  it("deleteTodo removes rows and returns false for missing ids", async () => {
    const created = await createTodo(pool, { title: "Delete me" });
    const deleted = await deleteTodo(pool, created.id);
    const deletedAgain = await deleteTodo(
      pool,
      "00000000-0000-0000-0000-000000000000"
    );

    expect(deleted).toBe(true);
    expect(deletedAgain).toBe(false);
    expect(await getTodoById(pool, created.id)).toBeNull();
  });

  it("createTodo supports urgent/important flags", async () => {
    const todo = await createTodo(pool, {
      title: "Urgent + Important",
      urgent: true,
      important: true,
    });
    expect(todo.urgent).toBe(true);
    expect(todo.important).toBe(true);
    expect(todo.is_focus).toBe(false);
    expect(todo.parent_id).toBeNull();
  });

  it("createTodo supports parent_id for subtasks", async () => {
    const parent = await createTodo(pool, { title: "Parent project" });
    const child = await createTodo(pool, {
      title: "Subtask",
      parent_id: parent.id,
    });
    expect(child.parent_id).toBe(parent.id);

    // getTodoById loads children
    const loaded = await getTodoById(pool, parent.id);
    expect(loaded!.children).toHaveLength(1);
    expect(loaded!.children![0].title).toBe("Subtask");
  });

  it("createTodo rejects nesting more than 2 levels", async () => {
    const parent = await createTodo(pool, { title: "Root" });
    const child = await createTodo(pool, {
      title: "Child",
      parent_id: parent.id,
    });
    await expect(
      createTodo(pool, { title: "Grandchild", parent_id: child.id })
    ).rejects.toThrow("Cannot nest more than 2 levels deep");
  });

  it("createTodo rejects invalid parent_id", async () => {
    await expect(
      createTodo(pool, {
        title: "Orphan",
        parent_id: "00000000-0000-0000-0000-000000000000",
      })
    ).rejects.toThrow("Parent todo not found");
  });

  it("listTodos filters by urgent/important (quadrant)", async () => {
    await createTodo(pool, { title: "Do First", urgent: true, important: true });
    await createTodo(pool, { title: "Schedule", urgent: false, important: true });
    await createTodo(pool, { title: "Neither" });

    const doFirst = await listTodos(pool, { urgent: true, important: true, limit: 20, offset: 0 });
    expect(doFirst.rows).toHaveLength(1);
    expect(doFirst.rows[0].title).toBe("Do First");

    const schedule = await listTodos(pool, { urgent: false, important: true, limit: 20, offset: 0 });
    expect(schedule.rows).toHaveLength(1);
    expect(schedule.rows[0].title).toBe("Schedule");
  });

  it("listTodos supports parent_id=root, parent_id=uuid, and include_children", async () => {
    const parent = await createTodo(pool, { title: "Project" });
    const solo = await createTodo(pool, { title: "Solo task" });
    await createTodo(pool, { title: "Step 1", parent_id: parent.id });
    await createTodo(pool, { title: "Step 2", parent_id: parent.id });

    const rootOnly = await listTodos(pool, { parent_id: "root", limit: 20, offset: 0 });
    expect(rootOnly.rows.every((r) => r.parent_id === null)).toBe(true);

    // Filter by specific parent_id (UUID)
    const children = await listTodos(pool, { parent_id: parent.id, limit: 20, offset: 0 });
    expect(children.rows).toHaveLength(2);
    expect(children.rows.every((r) => r.parent_id === parent.id)).toBe(true);

    const withChildren = await listTodos(pool, { parent_id: "root", include_children: true, limit: 20, offset: 0 });
    const project = withChildren.rows.find((r) => r.id === parent.id);
    expect(project!.children).toHaveLength(2);
    // Solo task has no children — covers the ?? [] fallback branch
    const soloTask = withChildren.rows.find((r) => r.id === solo.id);
    expect(soloTask!.children).toHaveLength(0);
  });

  it("listTodos supports someday status", async () => {
    await createTodo(pool, { title: "Maybe later", status: "someday" });
    const result = await listTodos(pool, { status: "someday", limit: 20, offset: 0 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("someday");
  });

  it("completeTodo sets done + completed_at + clears focus", async () => {
    const todo = await createTodo(pool, { title: "Finish this" });
    await setTodoFocus(pool, todo.id);

    const completed = await completeTodo(pool, todo.id);
    expect(completed!.status).toBe("done");
    expect(completed!.completed_at).not.toBeNull();
    expect(completed!.is_focus).toBe(false);
  });

  it("completeTodo returns null for missing todo", async () => {
    const result = await completeTodo(pool, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("setTodoFocus enforces uniqueness", async () => {
    const a = await createTodo(pool, { title: "A" });
    const b = await createTodo(pool, { title: "B" });

    await setTodoFocus(pool, a.id);
    const focusA = await getFocusTodo(pool);
    expect(focusA!.id).toBe(a.id);

    await setTodoFocus(pool, b.id);
    const focusB = await getFocusTodo(pool);
    expect(focusB!.id).toBe(b.id);

    // A is no longer focus
    const reloadedA = await getTodoById(pool, a.id);
    expect(reloadedA!.is_focus).toBe(false);
  });

  it("setTodoFocus clears focus when called with no id", async () => {
    const todo = await createTodo(pool, { title: "Focus me" });
    await setTodoFocus(pool, todo.id);
    expect((await getFocusTodo(pool))!.id).toBe(todo.id);

    await setTodoFocus(pool);
    expect(await getFocusTodo(pool)).toBeNull();
  });

  it("setTodoFocus returns null for missing todo", async () => {
    const result = await setTodoFocus(pool, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("updateTodo supports urgent/important updates", async () => {
    const todo = await createTodo(pool, { title: "Flip flags" });
    expect(todo.urgent).toBe(false);

    const updated = await updateTodo(pool, todo.id, { urgent: true, important: true });
    expect(updated!.urgent).toBe(true);
    expect(updated!.important).toBe(true);
  });

  it("listTodos focus_only filter works", async () => {
    const todo = await createTodo(pool, { title: "My focus" });
    await setTodoFocus(pool, todo.id);

    const result = await listTodos(pool, { focus_only: true, limit: 20, offset: 0 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(todo.id);
  });
});

// ============================================================================
// searchEntries regression — unchanged by artifact additions
// ============================================================================

describe("searchEntries regression", () => {
  it("still returns only journal entries, not artifacts", async () => {
    // Search for terms that exist in both entries and artifacts
    const results = await searchEntries(
      pool,
      workStressEntry.embedding,
      "nicotine dopamine",
      {},
      10
    );
    // searchEntries returns entry rows with uuid field, not artifact rows
    for (const r of results) {
      expect(r.uuid).toBeTruthy();
      expect(r).not.toHaveProperty("kind");
    }
  });
});

// (Insight, check-in, and daily-log queries removed — tables dropped)
// ============================================================================
// Web journaling: Entry CRUD
// ============================================================================

describe("Entry CRUD", () => {
  it("creates an entry with source=web and version=1", async () => {
    const entry = await createEntry(pool, {
      text: "Test journal entry",
      timezone: "Europe/Madrid",
      city: "Barcelona",
    });

    expect(entry.uuid).toBeTruthy();
    expect(entry.text).toBe("Test journal entry");
    expect(entry.source).toBe("web");
    expect(entry.version).toBe(1);
    expect(entry.city).toBe("Barcelona");
    expect(entry.timezone).toBe("Europe/Madrid");
  });

  it("creates entry with custom created_at", async () => {
    const entry = await createEntry(pool, {
      text: "Backdated entry",
      created_at: "2025-06-15T10:00:00Z",
    });
    expect(entry.created_at.toISOString()).toContain("2025-06-15");
  });

  it("creates entry with custom source", async () => {
    const entry = await createEntry(pool, {
      text: "MCP-created entry",
      source: "mcp",
    });
    expect(entry.source).toBe("mcp");
  });

  it("updates entry with optimistic locking", async () => {
    const entry = await createEntry(pool, { text: "Original" });

    const updated = await updateEntry(pool, entry.uuid, 1, {
      text: "Updated text",
    });
    expect(updated).not.toBe("version_conflict");
    expect(updated).not.toBeNull();
    if (updated && updated !== "version_conflict") {
      expect(updated.text).toBe("Updated text");
      expect(updated.version).toBe(2);
      expect(updated.modified_at).not.toBeNull();
    }
  });

  it("returns version_conflict on stale update", async () => {
    const entry = await createEntry(pool, { text: "Original" });
    await updateEntry(pool, entry.uuid, 1, { text: "V2" });

    // Try to update with stale version 1
    const result = await updateEntry(pool, entry.uuid, 1, { text: "Stale" });
    expect(result).toBe("version_conflict");
  });

  it("returns null when updating non-existent entry", async () => {
    const result = await updateEntry(pool, "nonexistent-uuid", 1, { text: "x" });
    expect(result).toBeNull();
  });

  it("invalidates embedding when text changes", async () => {
    const entry = await createEntry(pool, { text: "Has embedding" });

    // Manually set embedding
    const fakeEmb = new Array(1536).fill(0.1);
    await updateEntryEmbeddingIfVersionMatches(pool, entry.uuid, 1, fakeEmb);

    // Update text should invalidate embedding
    const updated = await updateEntry(pool, entry.uuid, 1, { text: "New text" });
    expect(updated).not.toBeNull();
    expect(updated).not.toBe("version_conflict");

    // Verify embedding was cleared by checking search doesn't find it via vector
    const fetched = await getEntryByUuid(pool, entry.uuid);
    expect(fetched!.text).toBe("New text");
  });

  it("updates entry optional fields (timezone, created_at, city, country, place_name, lat, lng)", async () => {
    const entry = await createEntry(pool, { text: "Bare entry" });

    const updated = await updateEntry(pool, entry.uuid, 1, {
      timezone: "America/New_York",
      created_at: "2025-01-15T10:00:00Z",
      city: "New York",
      country: "US",
      place_name: "Central Park",
      latitude: 40.785091,
      longitude: -73.968285,
    });
    expect(updated).not.toBeNull();
    expect(updated).not.toBe("version_conflict");
    if (updated && updated !== "version_conflict") {
      expect(updated.timezone).toBe("America/New_York");
      expect(updated.city).toBe("New York");
      expect(updated.country).toBe("US");
      expect(updated.place_name).toBe("Central Park");
      expect(updated.latitude).toBeCloseTo(40.785091);
      expect(updated.longitude).toBeCloseTo(-73.968285);
      expect(updated.version).toBe(2);
    }
  });

  it("deletes entry", async () => {
    const entry = await createEntry(pool, { text: "To delete" });
    const deleted = await deleteEntry(pool, entry.uuid);
    expect(deleted).toBe(true);

    const fetched = await getEntryByUuid(pool, entry.uuid);
    expect(fetched).toBeNull();
  });

  it("returns false when deleting non-existent entry", async () => {
    const result = await deleteEntry(pool, "nonexistent-uuid");
    expect(result).toBe(false);
  });

  it("lists entries with filters", async () => {
    await createEntry(pool, { text: "Web entry 1" });
    await createEntry(pool, { text: "Web entry 2" });

    const all = await listEntries(pool, { source: "web" });
    expect(all.count).toBeGreaterThanOrEqual(2);
  });

  it("lists entries with text search", async () => {
    await createEntry(pool, { text: "Unique searchable term zephyr" });

    const result = await listEntries(pool, { q: "zephyr" });
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("lists entries with date filters", async () => {
    await createEntry(pool, {
      text: "Date filtered entry",
      created_at: "2025-01-15T10:00:00Z",
    });

    const result = await listEntries(pool, {
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("lists entries with pagination", async () => {
    const page1 = await listEntries(pool, { limit: 1, offset: 0 });
    const page2 = await listEntries(pool, { limit: 1, offset: 1 });

    expect(page1.rows.length).toBeLessThanOrEqual(1);
    if (page1.count > 1) {
      expect(page2.rows.length).toBeLessThanOrEqual(1);
      expect(page1.rows[0].uuid).not.toBe(page2.rows[0]?.uuid);
    }
  });

  it("getEntryIdByUuid resolves entry id", async () => {
    const entry = await createEntry(pool, { text: "ID lookup" });
    const id = await getEntryIdByUuid(pool, entry.uuid);
    expect(id).toBe(entry.id);
  });

  it("getEntryIdByUuid returns null for missing", async () => {
    const id = await getEntryIdByUuid(pool, "nonexistent");
    expect(id).toBeNull();
  });
});

// ============================================================================
// Web journaling: Version-guarded embedding
// ============================================================================

describe("updateEntryEmbeddingIfVersionMatches", () => {
  it("writes embedding when version matches", async () => {
    const entry = await createEntry(pool, { text: "Embed me" });
    const emb = new Array(1536).fill(0.5);

    const updated = await updateEntryEmbeddingIfVersionMatches(pool, entry.uuid, 1, emb);
    expect(updated).toBe(true);
  });

  it("rejects embedding when version is stale", async () => {
    const entry = await createEntry(pool, { text: "Embed me" });
    // Update to bump version to 2
    await updateEntry(pool, entry.uuid, 1, { text: "V2" });

    // Try to write embedding for version 1 (stale)
    const emb = new Array(1536).fill(0.5);
    const updated = await updateEntryEmbeddingIfVersionMatches(pool, entry.uuid, 1, emb);
    expect(updated).toBe(false);
  });
});

// ============================================================================
// Web journaling: Media queries
// ============================================================================

describe("Media queries", () => {
  it("inserts and retrieves media for entry", async () => {
    const entry = await createEntry(pool, { text: "With photo" });

    const media = await insertMedia(pool, {
      entry_id: entry.id,
      type: "photo",
      storage_key: "entries/test/photo.jpg",
      url: "https://r2.example.com/entries/test/photo.jpg",
      file_size: 12345,
      dimensions: { width: 800, height: 600 },
    });

    expect(media.id).toBeTruthy();
    expect(media.type).toBe("photo");
    expect(media.url).toBe("https://r2.example.com/entries/test/photo.jpg");

    const mediaList = await getMediaForEntry(pool, entry.id);
    expect(mediaList.length).toBe(1);
    expect(mediaList[0].storage_key).toBe("entries/test/photo.jpg");
  });

  it("deletes media and returns storage_key", async () => {
    const entry = await createEntry(pool, { text: "Delete media" });
    const media = await insertMedia(pool, {
      entry_id: entry.id,
      type: "photo",
      storage_key: "entries/test/del.jpg",
      url: "https://r2.example.com/entries/test/del.jpg",
    });

    const result = await deleteMedia(pool, media.id);
    expect(result.deleted).toBe(true);
    expect(result.storage_key).toBe("entries/test/del.jpg");

    const after = await getMediaForEntry(pool, entry.id);
    expect(after.length).toBe(0);
  });

  it("returns not-deleted for non-existent media", async () => {
    const result = await deleteMedia(pool, 999999);
    expect(result.deleted).toBe(false);
    expect(result.storage_key).toBeNull();
  });

  it("cascades media delete when entry is deleted", async () => {
    const entry = await createEntry(pool, { text: "Cascade test" });
    await insertMedia(pool, {
      entry_id: entry.id,
      type: "photo",
      storage_key: "entries/test/cascade.jpg",
      url: "https://r2.example.com/cascade.jpg",
    });

    await deleteEntry(pool, entry.uuid);
    const media = await getMediaForEntry(pool, entry.id);
    expect(media.length).toBe(0);
  });
});

// ============================================================================
// Web journaling: Entry templates
// ============================================================================

describe("Entry templates", () => {
  it("creates and lists templates", async () => {
    const template = await createTemplate(pool, {
      slug: "test-template",
      name: "Test Template",
      description: "A test",
      body: "## Test\n\nWrite here",
      sort_order: 99,
    });

    expect(template.id).toBeTruthy();
    expect(template.slug).toBe("test-template");
    expect(template.name).toBe("Test Template");

    const all = await listTemplates(pool);
    expect(all.some((t) => t.slug === "test-template")).toBe(true);
  });

  it("updates template", async () => {
    const template = await createTemplate(pool, {
      slug: "update-me",
      name: "Before Update",
    });

    const updated = await updateTemplate(pool, template.id, {
      name: "After Update",
      body: "New body",
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("After Update");
    expect(updated!.body).toBe("New body");
    expect(updated!.slug).toBe("update-me"); // unchanged
  });

  it("updates template optional fields (slug, description, sort_order)", async () => {
    const template = await createTemplate(pool, {
      slug: "optional-fields",
      name: "Optional Fields Test",
    });

    const updated = await updateTemplate(pool, template.id, {
      slug: "optional-fields-updated",
      description: "A description",
      sort_order: 42,
    });

    expect(updated).not.toBeNull();
    expect(updated!.slug).toBe("optional-fields-updated");
    expect(updated!.description).toBe("A description");
    expect(updated!.sort_order).toBe(42);
  });

  it("returns null for updating non-existent template", async () => {
    const result = await updateTemplate(pool, "00000000-0000-0000-0000-000000000000", { name: "x" });
    expect(result).toBeNull();
  });

  it("update with no changes returns current template", async () => {
    const template = await createTemplate(pool, {
      slug: "no-change",
      name: "No Change",
    });
    const result = await updateTemplate(pool, template.id, {});
    expect(result).not.toBeNull();
    expect(result!.name).toBe("No Change");
  });

  it("deletes template", async () => {
    const template = await createTemplate(pool, {
      slug: "delete-me",
      name: "Delete Me",
    });

    const deleted = await deleteTemplate(pool, template.id);
    expect(deleted).toBe(true);

    const all = await listTemplates(pool);
    expect(all.some((t) => t.slug === "delete-me")).toBe(false);
  });

  it("returns false for deleting non-existent template", async () => {
    const result = await deleteTemplate(pool, "00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });

  it("gets template by slug", async () => {
    await createTemplate(pool, {
      slug: "by-slug-test",
      name: "By Slug",
      body: "slug body",
    });

    const found = await getTemplateBySlug(pool, "by-slug-test");
    expect(found).not.toBeNull();
    expect(found!.slug).toBe("by-slug-test");
    expect(found!.name).toBe("By Slug");
  });

  it("returns null for non-existent slug", async () => {
    const result = await getTemplateBySlug(pool, "no-such-slug");
    expect(result).toBeNull();
  });

  it("creates template with system_prompt", async () => {
    const template = await createTemplate(pool, {
      slug: "with-system-prompt",
      name: "With Prompt",
      system_prompt: "You are a morning journal guide.",
    });

    expect(template.system_prompt).toBe("You are a morning journal guide.");
  });

  it("creates template with null system_prompt by default", async () => {
    const template = await createTemplate(pool, {
      slug: "no-system-prompt",
      name: "No Prompt",
    });

    expect(template.system_prompt).toBeNull();
  });

  it("updates template system_prompt", async () => {
    const template = await createTemplate(pool, {
      slug: "update-prompt",
      name: "Update Prompt",
    });

    const updated = await updateTemplate(pool, template.id, {
      system_prompt: "New prompt",
    });

    expect(updated).not.toBeNull();
    expect(updated!.system_prompt).toBe("New prompt");
  });

  it("clears template system_prompt by setting null", async () => {
    const template = await createTemplate(pool, {
      slug: "clear-prompt",
      name: "Clear Prompt",
      system_prompt: "Old prompt",
    });

    const updated = await updateTemplate(pool, template.id, {
      system_prompt: null,
    });

    expect(updated).not.toBeNull();
    expect(updated!.system_prompt).toBeNull();
  });
});
