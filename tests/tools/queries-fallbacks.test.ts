import { describe, it, expect, vi } from "vitest";
import {
  getTotalApiCostSince,
  getLastCostNotificationTime,
  getTopPatterns,
  pruneExpiredEventPatterns,
  countStaleEventPatterns,
  insertSoulQualitySignal,
  insertPulseCheck,
  getVerbConjugations,
  getSpanishProfile,
  getSpanishVocabularyById,
  getSpanishAdaptiveContext,
  insertSpanishReview,
  upsertSpanishProgressSnapshot,
} from "../../src/db/queries.js";

describe("queries defensive fallbacks", () => {
  it("returns 0 total cost when aggregate query yields no rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Parameters<typeof getTotalApiCostSince>[0];

    const total = await getTotalApiCostSince(pool, new Date(0), new Date());
    expect(total).toBe(0);
  });

  it("returns null when no cost notification row exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Parameters<
      typeof getLastCostNotificationTime
    >[0];

    const last = await getLastCostNotificationTime(pool, "123");
    expect(last).toBeNull();
  });

  it("maps pattern row defaults for source metadata when absent", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 1,
          content: "pattern",
          kind: "behavior",
          confidence: "0.8",
          strength: "1.0",
          times_seen: 1,
          status: "active",
          temporal: null,
          canonical_hash: "abc",
          source_type: undefined,
          source_id: undefined,
          expires_at: undefined,
          first_seen: new Date("2026-01-01T00:00:00Z"),
          last_seen: new Date("2026-01-02T00:00:00Z"),
          created_at: new Date("2026-01-03T00:00:00Z"),
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof getTopPatterns>[0];

    const results = await getTopPatterns(pool, 1);
    expect(results).toHaveLength(1);
    expect(results[0].source_type).toBe("compaction");
    expect(results[0].source_id).toBeNull();
    expect(results[0].expires_at).toBeNull();
  });

  it("returns 0 for expired-pattern pruning when rowCount is missing", async () => {
    const query = vi.fn().mockResolvedValue({});
    const pool = { query } as unknown as Parameters<
      typeof pruneExpiredEventPatterns
    >[0];

    const changed = await pruneExpiredEventPatterns(pool);
    expect(changed).toBe(0);
  });

  it("returns 0 stale events when count query yields no rows", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Parameters<
      typeof countStaleEventPatterns
    >[0];

    const count = await countStaleEventPatterns(pool);
    expect(count).toBe(0);
  });

  it("maps soul quality signal metadata to {} when row metadata is nullish", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 1,
          chat_id: "100",
          assistant_message_id: null,
          signal_type: "felt_personal",
          soul_version: 1,
          pattern_count: 0,
          metadata: undefined,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = {
      query,
    } as unknown as Parameters<typeof insertSoulQualitySignal>[0];

    const result = await insertSoulQualitySignal(pool, {
      chatId: "100",
      assistantMessageId: null,
      signalType: "felt_personal",
      soulVersion: 1,
      patternCount: 0,
      metadata: {},
    });

    expect(result.metadata).toEqual({});
  });

  it("maps pulse check nullish JSON fields to empty defaults", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 7,
          chat_id: "100",
          status: "stale",
          personal_ratio: "0.1",
          correction_rate: "0.2",
          signal_counts: undefined,
          repairs_applied: undefined,
          soul_version_before: 1,
          soul_version_after: 1,
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof insertPulseCheck>[0];

    const result = await insertPulseCheck(pool, {
      chatId: "100",
      status: "stale",
      personalRatio: 0.1,
      correctionRate: 0.2,
      signalCounts: {},
      repairsApplied: [],
      soulVersionBefore: 1,
      soulVersionAfter: 1,
    });

    expect(result.signal_counts).toEqual({});
    expect(result.repairs_applied).toEqual([]);
  });

  it("maps spanish vocabulary difficulty to 0 when DB row omits it", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 1,
          chat_id: "100",
          word: "maje",
          translation: null,
          part_of_speech: null,
          region: undefined,
          example_sentence: null,
          notes: null,
          source: "chat",
          stability: undefined,
          difficulty: undefined,
          reps: 0,
          lapses: 0,
          state: "new",
          last_review: null,
          next_review: null,
          first_seen: new Date("2026-01-01T00:00:00Z"),
          last_seen: new Date("2026-01-01T00:00:00Z"),
          created_at: new Date("2026-01-01T00:00:00Z"),
          updated_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = {
      query,
    } as unknown as Parameters<typeof getSpanishVocabularyById>[0];

    const row = await getSpanishVocabularyById(pool, "100", 1);
    expect(row).not.toBeNull();
    expect(row!.difficulty).toBe(0);
    expect(row!.stability).toBe(0);
    expect(row!.region).toBe("");
  });

  it("maps spanish verb nullable text fields to null defaults", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 1,
          infinitive: "tener",
          infinitive_english: undefined,
          mood: "Indicativo",
          tense: "Presente",
          verb_english: undefined,
          form_1s: undefined,
          form_2s: undefined,
          form_3s: undefined,
          form_1p: undefined,
          form_2p: undefined,
          form_3p: undefined,
          gerund: undefined,
          past_participle: undefined,
          is_irregular: false,
          source: "jehle",
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof getVerbConjugations>[0];

    const rows = await getVerbConjugations(pool, {
      verb: "tener",
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].infinitive_english).toBeNull();
    expect(rows[0].verb_english).toBeNull();
    expect(rows[0].form_1s).toBeNull();
    expect(rows[0].past_participle).toBeNull();
  });

  it("maps spanish profile cefr_level to null when omitted", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          chat_id: "100",
          cefr_level: undefined,
          known_tenses: [],
          focus_topics: [],
          created_at: new Date("2026-01-01T00:00:00Z"),
          updated_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof getSpanishProfile>[0];

    const profile = await getSpanishProfile(pool, "100");
    expect(profile).not.toBeNull();
    expect(profile!.cefr_level).toBeNull();
  });

  it("falls back to streak_days=0 when streak query returns no rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ words_learned: 1, words_in_progress: 0, new_words_today: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [{ reviews_today: 0, tenses_practiced: [] }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            chat_id: "100",
            date: new Date("2026-01-01T00:00:00Z"),
            words_learned: 1,
            words_in_progress: 0,
            reviews_today: 0,
            new_words_today: 1,
            tenses_practiced: [],
            streak_days: 0,
            created_at: new Date("2026-01-01T00:00:00Z"),
            updated_at: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      });
    const pool = {
      query,
    } as unknown as Parameters<typeof upsertSpanishProgressSnapshot>[0];

    const row = await upsertSpanishProgressSnapshot(pool, "100", "2026-01-01");
    expect(row.streak_days).toBe(0);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("returns adaptive context row from single-row query result", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          recent_avg_grade: 2.8,
          recent_lapse_rate: 0.15,
          avg_difficulty: 4.2,
          total_reviews: 30,
          mastered_count: 10,
          struggling_count: 2,
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof getSpanishAdaptiveContext>[0];

    const ctx = await getSpanishAdaptiveContext(pool, "100");
    expect(ctx.recent_avg_grade).toBe(2.8);
    expect(ctx.recent_lapse_rate).toBe(0.15);
    expect(ctx.avg_difficulty).toBe(4.2);
    expect(ctx.total_reviews).toBe(30);
    expect(ctx.mastered_count).toBe(10);
    expect(ctx.struggling_count).toBe(2);
  });

  it("maps spanish review nullable numeric fields to null", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 5,
          chat_id: "100",
          vocabulary_id: 7,
          grade: 3,
          stability_before: null,
          stability_after: null,
          difficulty_before: null,
          difficulty_after: null,
          interval_days: null,
          retrievability: null,
          review_context: "conversation",
          reviewed_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });
    const pool = { query } as unknown as Parameters<typeof insertSpanishReview>[0];

    const review = await insertSpanishReview(pool, {
      chatId: "100",
      vocabularyId: 7,
      grade: 3,
      stabilityBefore: null,
      stabilityAfter: null,
      difficultyBefore: null,
      difficultyAfter: null,
      intervalDays: null,
      retrievability: null,
      reviewContext: "conversation",
    });

    expect(review.stability_before).toBeNull();
    expect(review.difficulty_after).toBeNull();
    expect(review.interval_days).toBeNull();
    expect(review.retrievability).toBeNull();
  });
});
