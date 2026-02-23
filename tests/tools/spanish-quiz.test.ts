import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueries = vi.hoisted(() => ({
  getDueSpanishVocabulary: vi.fn(),
  getSpanishVocabularyById: vi.fn(),
  updateSpanishVocabularySchedule: vi.fn(),
  insertSpanishReview: vi.fn(),
  getSpanishQuizStats: vi.fn(),
  upsertSpanishProgressSnapshot: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({
  config: {
    timezone: "Europe/Madrid",
  },
}));

vi.mock("../../src/db/queries.js", () => mockQueries);
vi.mock("../../src/config.js", () => mockConfig);

import { handleSpanishQuiz } from "../../src/tools/spanish-quiz.js";

const mockPool = {} as any;

const baseCard = {
  id: 42,
  chat_id: "123",
  word: "maje",
  translation: "dude",
  part_of_speech: "noun",
  region: "honduras",
  example_sentence: null,
  notes: null,
  source: "chat",
  stability: 1.2,
  difficulty: 5,
  reps: 0,
  lapses: 0,
  state: "new" as const,
  last_review: null,
  next_review: null,
  first_seen: new Date("2026-02-20T10:00:00Z"),
  last_seen: new Date("2026-02-20T10:00:00Z"),
  created_at: new Date("2026-02-20T10:00:00Z"),
  updated_at: new Date("2026-02-20T10:00:00Z"),
};

beforeEach(() => {
  Object.values(mockQueries).forEach((fn) => fn.mockReset());
  mockQueries.upsertSpanishProgressSnapshot.mockResolvedValue({
    date: new Date("2026-02-23T00:00:00Z"),
    words_learned: 1,
    words_in_progress: 1,
    reviews_today: 1,
    new_words_today: 1,
    streak_days: 1,
  });
});

describe("handleSpanishQuiz", () => {
  it("returns due cards for get_due action", async () => {
    mockQueries.getDueSpanishVocabulary.mockResolvedValue([baseCard]);

    const result = await handleSpanishQuiz(mockPool, {
      action: "get_due",
      chat_id: "123",
      limit: 5,
    });
    const parsed = JSON.parse(result);

    expect(mockQueries.getDueSpanishVocabulary).toHaveBeenCalledWith(
      mockPool,
      "123",
      5
    );
    expect(parsed[0]).toMatchObject({
      id: 42,
      word: "maje",
    });
  });

  it("maps due cards with empty region and explicit next review", async () => {
    mockQueries.getDueSpanishVocabulary.mockResolvedValue([
      {
        ...baseCard,
        region: "",
        next_review: new Date("2026-02-24T10:00:00Z"),
      },
    ]);

    const result = await handleSpanishQuiz(mockPool, {
      action: "get_due",
      chat_id: "123",
      limit: 1,
    });
    const parsed = JSON.parse(result);

    expect(parsed[0].region).toBeNull();
    expect(parsed[0].next_review).toContain("2026-02-24");
  });

  it("returns message when nothing is due", async () => {
    mockQueries.getDueSpanishVocabulary.mockResolvedValue([]);

    const result = await handleSpanishQuiz(mockPool, {
      action: "get_due",
      chat_id: "123",
    });
    expect(result).toContain("No vocabulary due right now");
  });

  it("returns stats payload", async () => {
    mockQueries.getSpanishQuizStats.mockResolvedValue({
      total_words: 4,
      due_now: 2,
      new_words: 1,
      learning_words: 1,
      review_words: 2,
      relearning_words: 0,
      reviews_today: 3,
      average_grade: 3.1,
    });

    const result = await handleSpanishQuiz(mockPool, {
      action: "stats",
      chat_id: "123",
    });
    const parsed = JSON.parse(result);

    expect(parsed.stats.total_words).toBe(4);
    expect(parsed.progress.words_learned).toBe(1);
  });

  it("requires vocabulary_id and grade for record_review", async () => {
    await expect(
      handleSpanishQuiz(mockPool, {
        action: "record_review",
        chat_id: "123",
      })
    ).rejects.toThrow("requires vocabulary_id and grade");
  });

  it("errors when record_review card is missing", async () => {
    mockQueries.getSpanishVocabularyById.mockResolvedValue(null);

    await expect(
      handleSpanishQuiz(mockPool, {
        action: "record_review",
        chat_id: "123",
        vocabulary_id: 99,
        grade: 3,
      })
    ).rejects.toThrow("not found");
  });

  it("records relearning schedule for low grade", async () => {
    mockQueries.getSpanishVocabularyById.mockResolvedValue({
      ...baseCard,
      state: "review",
      reps: 3,
    });
    mockQueries.updateSpanishVocabularySchedule.mockImplementation(
      async (_pool: unknown, params: Record<string, unknown>) => ({
        ...baseCard,
        id: Number(params.vocabularyId),
        state: params.state,
        next_review: params.nextReview,
      })
    );
    mockQueries.insertSpanishReview.mockResolvedValue({});

    const result = await handleSpanishQuiz(mockPool, {
      action: "record_review",
      chat_id: "123",
      vocabulary_id: 42,
      grade: 1,
      review_context: "conversation",
    });
    const parsed = JSON.parse(result);

    expect(mockQueries.updateSpanishVocabularySchedule).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        state: "relearning",
        lapses: 1,
      })
    );
    expect(parsed.review.state).toBe("relearning");
  });

  it("records learning schedule for grade 3", async () => {
    mockQueries.getSpanishVocabularyById.mockResolvedValue({
      ...baseCard,
      state: "new",
      reps: 0,
      lapses: 0,
    });
    mockQueries.updateSpanishVocabularySchedule.mockImplementation(
      async (_pool: unknown, params: Record<string, unknown>) => ({
        ...baseCard,
        id: Number(params.vocabularyId),
        state: params.state,
        next_review: params.nextReview,
      })
    );
    mockQueries.insertSpanishReview.mockResolvedValue({});

    const result = await handleSpanishQuiz(mockPool, {
      action: "record_review",
      chat_id: "123",
      vocabulary_id: 42,
      grade: 3,
    });
    const parsed = JSON.parse(result);

    expect(mockQueries.updateSpanishVocabularySchedule).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        state: "learning",
      })
    );
    expect(parsed.review.state).toBe("learning");
  });

  it("records review state for grade 3 when card is not new", async () => {
    mockQueries.getSpanishVocabularyById.mockResolvedValue({
      ...baseCard,
      state: "review",
      reps: 1,
    });
    mockQueries.updateSpanishVocabularySchedule.mockImplementation(
      async (_pool: unknown, params: Record<string, unknown>) => ({
        ...baseCard,
        id: Number(params.vocabularyId),
        state: params.state,
        next_review: params.nextReview,
      })
    );
    mockQueries.insertSpanishReview.mockResolvedValue({});

    const result = await handleSpanishQuiz(mockPool, {
      action: "record_review",
      chat_id: "123",
      vocabulary_id: 42,
      grade: 3,
    });
    const parsed = JSON.parse(result);
    expect(parsed.review.state).toBe("review");
  });

  it("records review schedule for grade 4", async () => {
    mockQueries.getSpanishVocabularyById.mockResolvedValue({
      ...baseCard,
      state: "review",
      reps: 2,
    });
    mockQueries.updateSpanishVocabularySchedule.mockImplementation(
      async (_pool: unknown, params: Record<string, unknown>) => ({
        ...baseCard,
        id: Number(params.vocabularyId),
        state: params.state,
        next_review: params.nextReview,
      })
    );
    mockQueries.insertSpanishReview.mockResolvedValue({});

    const result = await handleSpanishQuiz(mockPool, {
      action: "record_review",
      chat_id: "123",
      vocabulary_id: 42,
      grade: 4,
    });
    const parsed = JSON.parse(result);

    expect(mockQueries.updateSpanishVocabularySchedule).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        state: "review",
      })
    );
    expect(parsed.status).toBe("recorded");
  });

  it("maps null next_review in record_review response", async () => {
    mockQueries.getSpanishVocabularyById.mockResolvedValue({
      ...baseCard,
      state: "review",
      reps: 2,
    });
    mockQueries.updateSpanishVocabularySchedule.mockResolvedValue({
      ...baseCard,
      id: 42,
      state: "review",
      next_review: null,
    });
    mockQueries.insertSpanishReview.mockResolvedValue({});

    const result = await handleSpanishQuiz(mockPool, {
      action: "record_review",
      chat_id: "123",
      vocabulary_id: 42,
      grade: 4,
    });
    const parsed = JSON.parse(result);
    expect(parsed.review.next_review).toBeNull();
  });

  it("uses baseline stability/difficulty when card values are non-positive", async () => {
    mockQueries.getSpanishVocabularyById.mockResolvedValue({
      ...baseCard,
      stability: 0,
      difficulty: 0,
      state: "review",
      reps: 1,
    });
    mockQueries.updateSpanishVocabularySchedule.mockImplementation(
      async (_pool: unknown, params: Record<string, unknown>) => ({
        ...baseCard,
        id: Number(params.vocabularyId),
        state: params.state,
        stability: params.stability,
        difficulty: params.difficulty,
        next_review: params.nextReview,
      })
    );
    mockQueries.insertSpanishReview.mockResolvedValue({});

    await handleSpanishQuiz(mockPool, {
      action: "record_review",
      chat_id: "123",
      vocabulary_id: 42,
      grade: 4,
    });

    expect(mockQueries.updateSpanishVocabularySchedule).toHaveBeenCalledWith(
      mockPool,
      expect.objectContaining({
        stability: expect.any(Number),
        difficulty: 4.75,
      })
    );
  });
});
