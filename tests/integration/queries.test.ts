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
  upsertDailyMetric,
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
  getTopPatterns,
  insertPatternObservation,
  insertPatternRelation,
  insertPatternAlias,
  linkPatternToEntry,
  logApiUsage,
  getUsageSummary,
} from "../../src/db/queries.js";
import { fixturePatterns } from "../../specs/fixtures/seed.js";

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
