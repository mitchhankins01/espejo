import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import {
  getDueSpanishVocabulary,
  getSpanishVocabularyById,
  updateSpanishVocabularySchedule,
  insertSpanishReview,
  getSpanishQuizStats,
  upsertSpanishProgressSnapshot,
  type SpanishVocabularyRow,
} from "../db/queries.js";
import { config } from "../config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function todayInTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scheduleReview(
  card: SpanishVocabularyRow,
  grade: number
): {
  state: SpanishVocabularyRow["state"];
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  intervalDays: number;
  nextReview: Date;
  retrievability: number;
} {
  const now = new Date();
  const priorStability = card.stability > 0 ? card.stability : 0.3;
  const priorDifficulty = card.difficulty > 0 ? card.difficulty : 5;
  const reps = card.reps + 1;
  const difficultyDelta = grade <= 2 ? 0.4 : grade === 3 ? -0.1 : -0.25;
  const difficulty = clamp(priorDifficulty + difficultyDelta, 1, 10);

  if (grade <= 2) {
    const lapses = card.lapses + 1;
    const stability = clamp(priorStability * 0.5, 0.1, 365);
    const intervalDays = 0.5;
    return {
      state: "relearning",
      stability,
      difficulty,
      reps,
      lapses,
      intervalDays,
      nextReview: new Date(now.getTime() + intervalDays * DAY_MS),
      retrievability: 0.35,
    };
  }

  if (grade === 3) {
    const stability = clamp(priorStability * 1.6 + 0.4, 0.2, 3650);
    const intervalDays = Math.max(1, Math.round(stability));
    return {
      state: card.state === "new" ? "learning" : "review",
      stability,
      difficulty,
      reps,
      lapses: card.lapses,
      intervalDays,
      nextReview: new Date(now.getTime() + intervalDays * DAY_MS),
      retrievability: 0.78,
    };
  }

  const stability = clamp(priorStability * 2.1 + 1, 0.3, 3650);
  const intervalDays = Math.max(2, Math.round(stability));
  return {
    state: "review",
    stability,
    difficulty,
    reps,
    lapses: card.lapses,
    intervalDays,
    nextReview: new Date(now.getTime() + intervalDays * DAY_MS),
    retrievability: 0.92,
  };
}

export async function handleSpanishQuiz(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("spanish_quiz", input);

  if (params.action === "get_due") {
    const due = await getDueSpanishVocabulary(pool, params.chat_id, params.limit);
    if (due.length === 0) return "No vocabulary due right now.";

    return JSON.stringify(
      due.map((row) => ({
        id: row.id,
        word: row.word,
        translation: row.translation,
        region: row.region || null,
        part_of_speech: row.part_of_speech,
        state: row.state,
        next_review: row.next_review?.toISOString() ?? null,
      })),
      null,
      2
    );
  }

  if (params.action === "stats") {
    const stats = await getSpanishQuizStats(pool, params.chat_id);
    const progress = await upsertSpanishProgressSnapshot(
      pool,
      params.chat_id,
      todayInTimezone()
    );
    return JSON.stringify(
      {
        stats,
        progress: {
          date: progress.date.toISOString().slice(0, 10),
          words_learned: progress.words_learned,
          words_in_progress: progress.words_in_progress,
          reviews_today: progress.reviews_today,
          new_words_today: progress.new_words_today,
          streak_days: progress.streak_days,
        },
      },
      null,
      2
    );
  }

  if (!params.vocabulary_id || !params.grade) {
    throw new Error(
      "spanish_quiz action=record_review requires vocabulary_id and grade (1-4)."
    );
  }

  const existing = await getSpanishVocabularyById(
    pool,
    params.chat_id,
    params.vocabulary_id
  );
  if (!existing) {
    throw new Error(
      `Vocabulary ${params.vocabulary_id} not found for chat ${params.chat_id}.`
    );
  }

  const scheduled = scheduleReview(existing, params.grade);
  const reviewedAt = new Date();
  const updated = await updateSpanishVocabularySchedule(pool, {
    chatId: params.chat_id,
    vocabularyId: params.vocabulary_id,
    state: scheduled.state,
    stability: scheduled.stability,
    difficulty: scheduled.difficulty,
    reps: scheduled.reps,
    lapses: scheduled.lapses,
    lastReview: reviewedAt,
    nextReview: scheduled.nextReview,
  });

  await insertSpanishReview(pool, {
    chatId: params.chat_id,
    vocabularyId: params.vocabulary_id,
    grade: params.grade,
    stabilityBefore: existing.stability,
    stabilityAfter: scheduled.stability,
    difficultyBefore: existing.difficulty,
    difficultyAfter: scheduled.difficulty,
    intervalDays: scheduled.intervalDays,
    retrievability: scheduled.retrievability,
    reviewContext: params.review_context ?? "conversation",
  });

  await upsertSpanishProgressSnapshot(pool, params.chat_id, todayInTimezone());

  return JSON.stringify(
    {
      status: "recorded",
      review: {
        vocabulary_id: updated.id,
        word: updated.word,
        grade: params.grade,
        interval_days: scheduled.intervalDays,
        next_review: updated.next_review?.toISOString() ?? null,
        state: updated.state,
      },
    },
    null,
    2
  );
}

