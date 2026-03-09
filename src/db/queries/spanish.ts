import type pg from "pg";
import { config } from "../../config.js";

// ============================================================================
// Spanish learning queries
// ============================================================================

export interface SpanishProfileRow {
  chat_id: string;
  cefr_level: string | null;
  known_tenses: string[];
  focus_topics: string[];
  created_at: Date;
  updated_at: Date;
}

export interface SpanishVerbRow {
  id: number;
  infinitive: string;
  infinitive_english: string | null;
  mood: string;
  tense: string;
  verb_english: string | null;
  form_1s: string | null;
  form_2s: string | null;
  form_3s: string | null;
  form_1p: string | null;
  form_2p: string | null;
  form_3p: string | null;
  gerund: string | null;
  past_participle: string | null;
  is_irregular: boolean;
  source: string;
  created_at: Date;
}

export interface SpanishVocabularyRow {
  id: number;
  chat_id: string;
  word: string;
  translation: string | null;
  part_of_speech: string | null;
  region: string;
  example_sentence: string | null;
  notes: string | null;
  source: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  state: "new" | "learning" | "review" | "relearning";
  last_review: Date | null;
  next_review: Date | null;
  first_seen: Date;
  last_seen: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SpanishReviewRow {
  id: number;
  chat_id: string;
  vocabulary_id: number;
  grade: number;
  stability_before: number | null;
  stability_after: number | null;
  difficulty_before: number | null;
  difficulty_after: number | null;
  interval_days: number | null;
  retrievability: number | null;
  review_context: string;
  reviewed_at: Date;
}

export interface SpanishQuizStatsRow {
  total_words: number;
  due_now: number;
  new_words: number;
  learning_words: number;
  review_words: number;
  relearning_words: number;
  reviews_today: number;
  average_grade: number;
}

export interface SpanishAdaptiveContextRow {
  recent_avg_grade: number;
  recent_lapse_rate: number;
  avg_difficulty: number;
  total_reviews: number;
  mastered_count: number;
  struggling_count: number;
}

export interface SpanishProgressRow {
  id: number;
  chat_id: string;
  date: Date;
  words_learned: number;
  words_in_progress: number;
  reviews_today: number;
  new_words_today: number;
  tenses_practiced: string[];
  streak_days: number;
  created_at: Date;
  updated_at: Date;
}

// ============================================================================
// Spanish analytics types
// ============================================================================

export interface RetentionBucketRow {
  interval_bucket: string;
  total_reviews: number;
  retained: number;
  retention_rate: number;
}

export interface VocabularyFunnelRow {
  state: string;
  count: number;
  median_days_in_state: number | null;
}

export interface GradeTrendRow {
  date: string;
  avg_grade: number;
  review_count: number;
}

export interface LapseRateTrendRow {
  date: string;
  lapse_rate: number;
  review_count: number;
}

export interface SpanishAssessmentRow {
  id: number;
  chat_id: string;
  complexity_score: number;
  grammar_score: number;
  vocabulary_score: number;
  code_switching_ratio: number;
  overall_score: number;
  sample_message_count: number;
  rationale: string;
  assessed_at: Date;
}

function normalizeVocabularyWord(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeVocabularyRegion(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export async function getSpanishProfile(
  pool: pg.Pool,
  chatId: string
): Promise<SpanishProfileRow | null> {
  const result = await pool.query(
    `SELECT *
     FROM spanish_profiles
     WHERE chat_id = $1
     LIMIT 1`,
    [chatId]
  );
  if (result.rows.length === 0) return null;
  return mapSpanishProfileRow(result.rows[0]);
}

export async function upsertSpanishProfile(
  pool: pg.Pool,
  params: {
    chatId: string;
    cefrLevel: string | null;
    knownTenses: string[];
    focusTopics: string[];
  }
): Promise<SpanishProfileRow> {
  const result = await pool.query(
    `INSERT INTO spanish_profiles (
      chat_id, cefr_level, known_tenses, focus_topics
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id) DO UPDATE SET
       cefr_level = COALESCE(EXCLUDED.cefr_level, spanish_profiles.cefr_level),
       known_tenses = CASE
         WHEN cardinality(EXCLUDED.known_tenses) = 0 THEN spanish_profiles.known_tenses
         ELSE EXCLUDED.known_tenses
       END,
       focus_topics = CASE
         WHEN cardinality(EXCLUDED.focus_topics) = 0 THEN spanish_profiles.focus_topics
         ELSE EXCLUDED.focus_topics
       END,
       updated_at = NOW()
     RETURNING *`,
    [
      params.chatId,
      params.cefrLevel,
      params.knownTenses,
      params.focusTopics,
    ]
  );
  return mapSpanishProfileRow(result.rows[0]);
}

export async function getVerbConjugations(
  pool: pg.Pool,
  params: {
    verb: string;
    mood?: string;
    tense?: string;
    limit: number;
  }
): Promise<SpanishVerbRow[]> {
  const conditions: string[] = ["LOWER(infinitive) = LOWER($1)"];
  const values: unknown[] = [params.verb.trim()];

  if (params.mood) {
    values.push(params.mood.trim());
    conditions.push(`LOWER(mood) = LOWER($${values.length})`);
  }
  if (params.tense) {
    values.push(params.tense.trim());
    conditions.push(`LOWER(tense) = LOWER($${values.length})`);
  }

  values.push(params.limit);

  const result = await pool.query(
    `SELECT *
     FROM spanish_verbs
     WHERE ${conditions.join(" AND ")}
     ORDER BY mood ASC, tense ASC
     LIMIT $${values.length}`,
    values
  );

  return result.rows.map(mapSpanishVerbRow);
}

export async function upsertSpanishVocabulary(
  pool: pg.Pool,
  params: {
    chatId: string;
    word: string;
    translation?: string;
    partOfSpeech?: string;
    region?: string;
    exampleSentence?: string;
    notes?: string;
    source?: string;
  }
): Promise<{ row: SpanishVocabularyRow; inserted: boolean }> {
  const normalizedWord = normalizeVocabularyWord(params.word);
  const normalizedRegion = normalizeVocabularyRegion(params.region);
  const result = await pool.query(
    `INSERT INTO spanish_vocabulary (
      chat_id, word, translation, part_of_speech, region,
      example_sentence, notes, source
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (chat_id, word, region) DO UPDATE SET
      translation = COALESCE(EXCLUDED.translation, spanish_vocabulary.translation),
      part_of_speech = COALESCE(EXCLUDED.part_of_speech, spanish_vocabulary.part_of_speech),
      example_sentence = COALESCE(EXCLUDED.example_sentence, spanish_vocabulary.example_sentence),
      notes = COALESCE(EXCLUDED.notes, spanish_vocabulary.notes),
      source = EXCLUDED.source,
      last_seen = NOW(),
      updated_at = NOW()
    RETURNING *, (xmax = 0) AS inserted`,
    [
      params.chatId,
      normalizedWord,
      params.translation ?? null,
      params.partOfSpeech ?? null,
      normalizedRegion,
      params.exampleSentence ?? null,
      params.notes ?? null,
      params.source ?? "chat",
    ]
  );

  return {
    row: mapSpanishVocabularyRow(result.rows[0]),
    inserted: Boolean(result.rows[0].inserted),
  };
}

export async function getSpanishVocabularyById(
  pool: pg.Pool,
  chatId: string,
  vocabularyId: number
): Promise<SpanishVocabularyRow | null> {
  const result = await pool.query(
    `SELECT *
     FROM spanish_vocabulary
     WHERE chat_id = $1 AND id = $2
     LIMIT 1`,
    [chatId, vocabularyId]
  );
  if (result.rows.length === 0) return null;
  return mapSpanishVocabularyRow(result.rows[0]);
}

export async function getDueSpanishVocabulary(
  pool: pg.Pool,
  chatId: string,
  limit: number
): Promise<SpanishVocabularyRow[]> {
  const result = await pool.query(
    `SELECT *
     FROM spanish_vocabulary
     WHERE chat_id = $1
       AND (
         state = 'new'
         OR next_review IS NULL
         OR next_review <= NOW()
       )
     ORDER BY
       CASE WHEN state = 'new' THEN 0 ELSE 1 END,
       COALESCE(next_review, first_seen) ASC,
       id ASC
     LIMIT $2`,
    [chatId, limit]
  );
  return result.rows.map(mapSpanishVocabularyRow);
}

export async function getRecentSpanishVocabulary(
  pool: pg.Pool,
  chatId: string,
  limit: number
): Promise<SpanishVocabularyRow[]> {
  const result = await pool.query(
    `SELECT *
     FROM spanish_vocabulary
     WHERE chat_id = $1
     ORDER BY last_seen DESC, id DESC
     LIMIT $2`,
    [chatId, limit]
  );
  return result.rows.map(mapSpanishVocabularyRow);
}

export async function updateSpanishVocabularySchedule(
  pool: pg.Pool,
  params: {
    chatId: string;
    vocabularyId: number;
    state: "new" | "learning" | "review" | "relearning";
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    lastReview: Date;
    nextReview: Date;
  }
): Promise<SpanishVocabularyRow> {
  const result = await pool.query(
    `UPDATE spanish_vocabulary
     SET
       state = $3,
       stability = $4,
       difficulty = $5,
       reps = $6,
       lapses = $7,
       last_review = $8,
       next_review = $9,
       last_seen = GREATEST(last_seen, $8),
       updated_at = NOW()
     WHERE chat_id = $1
       AND id = $2
     RETURNING *`,
    [
      params.chatId,
      params.vocabularyId,
      params.state,
      params.stability,
      params.difficulty,
      params.reps,
      params.lapses,
      params.lastReview,
      params.nextReview,
    ]
  );

  if (result.rows.length === 0) {
    throw new Error(`Vocabulary ${params.vocabularyId} not found for chat ${params.chatId}`);
  }

  return mapSpanishVocabularyRow(result.rows[0]);
}

export async function insertSpanishReview(
  pool: pg.Pool,
  params: {
    chatId: string;
    vocabularyId: number;
    grade: number;
    stabilityBefore: number | null;
    stabilityAfter: number | null;
    difficultyBefore: number | null;
    difficultyAfter: number | null;
    intervalDays: number | null;
    retrievability: number | null;
    reviewContext: string;
  }
): Promise<SpanishReviewRow> {
  const result = await pool.query(
    `INSERT INTO spanish_reviews (
      chat_id,
      vocabulary_id,
      grade,
      stability_before,
      stability_after,
      difficulty_before,
      difficulty_after,
      interval_days,
      retrievability,
      review_context
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      params.chatId,
      params.vocabularyId,
      params.grade,
      params.stabilityBefore,
      params.stabilityAfter,
      params.difficultyBefore,
      params.difficultyAfter,
      params.intervalDays,
      params.retrievability,
      params.reviewContext,
    ]
  );
  return mapSpanishReviewRow(result.rows[0]);
}

export async function getSpanishQuizStats(
  pool: pg.Pool,
  chatId: string
): Promise<SpanishQuizStatsRow> {
  const summaryResult = await pool.query(
    `SELECT
      COUNT(*)::int AS total_words,
      COALESCE(SUM((state = 'new')::int), 0)::int AS new_words,
      COALESCE(SUM((state = 'learning')::int), 0)::int AS learning_words,
      COALESCE(SUM((state = 'review')::int), 0)::int AS review_words,
      COALESCE(SUM((state = 'relearning')::int), 0)::int AS relearning_words,
      COALESCE(SUM((state = 'new' OR next_review IS NULL OR next_review <= NOW())::int), 0)::int AS due_now
     FROM spanish_vocabulary
     WHERE chat_id = $1`,
    [chatId]
  );

  const reviewResult = await pool.query(
    `SELECT
      COALESCE(
        SUM((((reviewed_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date)::int)),
        0
      )::int AS reviews_today,
      COALESCE(AVG(grade)::float, 0)::float AS average_grade
     FROM spanish_reviews
     WHERE chat_id = $1`,
    [chatId, config.timezone]
  );

  const summary = summaryResult.rows[0];
  const review = reviewResult.rows[0];
  return {
    total_words: summary.total_words,
    due_now: summary.due_now,
    new_words: summary.new_words,
    learning_words: summary.learning_words,
    review_words: summary.review_words,
    relearning_words: summary.relearning_words,
    reviews_today: review.reviews_today,
    average_grade: review.average_grade,
  };
}

export async function getSpanishAdaptiveContext(
  pool: pg.Pool,
  chatId: string
): Promise<SpanishAdaptiveContextRow> {
  const result = await pool.query(
    `SELECT
      COALESCE((
        SELECT AVG(grade)::float FROM spanish_reviews
        WHERE chat_id = $1 AND reviewed_at > NOW() - INTERVAL '30 days'
      ), 0)::float AS recent_avg_grade,
      COALESCE((
        SELECT COUNT(*) FILTER (WHERE grade <= 2)::float / NULLIF(COUNT(*), 0)
        FROM spanish_reviews
        WHERE chat_id = $1 AND reviewed_at > NOW() - INTERVAL '30 days'
      ), 0)::float AS recent_lapse_rate,
      COALESCE((
        SELECT AVG(difficulty)::float FROM spanish_vocabulary
        WHERE chat_id = $1 AND state != 'new'
      ), 0)::float AS avg_difficulty,
      COALESCE((
        SELECT COUNT(*)::int FROM spanish_reviews WHERE chat_id = $1
      ), 0)::int AS total_reviews,
      COALESCE((
        SELECT COUNT(*)::int FROM spanish_vocabulary
        WHERE chat_id = $1 AND state = 'review' AND difficulty < 4
      ), 0)::int AS mastered_count,
      COALESCE((
        SELECT COUNT(*)::int FROM spanish_vocabulary
        WHERE chat_id = $1 AND (state = 'relearning' OR (state = 'learning' AND lapses > 1))
      ), 0)::int AS struggling_count`,
    [chatId]
  );
  return result.rows[0];
}

export async function upsertSpanishProgressSnapshot(
  pool: pg.Pool,
  chatId: string,
  date: string
): Promise<SpanishProgressRow> {
  const vocabularyResult = await pool.query(
    `SELECT
      COUNT(*)::int AS words_learned,
      COALESCE(SUM((state IN ('learning', 'review', 'relearning'))::int), 0)::int AS words_in_progress,
      COALESCE(SUM((((first_seen AT TIME ZONE $3)::date = $2::date)::int)), 0)::int AS new_words_today
     FROM spanish_vocabulary
     WHERE chat_id = $1`,
    [chatId, date, config.timezone]
  );

  const reviewResult = await pool.query(
    `SELECT
      COUNT(*)::int AS reviews_today,
      COALESCE(
        array_remove(
          array_agg(
            DISTINCT NULLIF(
              substring(review_context FROM 'tense:([^,\\s]+)'),
              ''
            )
          ),
          NULL
        ),
        '{}'::text[]
     ) AS tenses_practiced
     FROM spanish_reviews
     WHERE chat_id = $1
       AND (reviewed_at AT TIME ZONE $3)::date = $2::date`,
    [chatId, date, config.timezone]
  );

  const streakResult = await pool.query(
    `WITH activity_days AS (
      SELECT DISTINCT (reviewed_at AT TIME ZONE $3)::date AS day
      FROM spanish_reviews
      WHERE chat_id = $1 AND (reviewed_at AT TIME ZONE $3)::date <= $2::date
      UNION
      SELECT DISTINCT (first_seen AT TIME ZONE $3)::date AS day
      FROM spanish_vocabulary
      WHERE chat_id = $1 AND (first_seen AT TIME ZONE $3)::date <= $2::date
    ),
    grouped AS (
      SELECT
        day,
        day - (ROW_NUMBER() OVER (ORDER BY day))::int AS grp
      FROM activity_days
    ),
    streaks AS (
      SELECT
        grp,
        COUNT(*)::int AS streak_length,
        MAX(day) AS streak_end
      FROM grouped
      GROUP BY grp
    )
    SELECT COALESCE((
      SELECT streak_length
      FROM streaks
      WHERE streak_end = $2::date
      ORDER BY streak_length DESC
      LIMIT 1
    ), 0) AS streak_days`,
    [chatId, date, config.timezone]
  );

  const vocabulary = vocabularyResult.rows[0];
  const reviews = reviewResult.rows[0];
  const streakDays = streakResult.rows[0]?.streak_days ?? 0;

  const result = await pool.query(
    `INSERT INTO spanish_progress (
      chat_id,
      date,
      words_learned,
      words_in_progress,
      reviews_today,
      new_words_today,
      tenses_practiced,
      streak_days
    )
    VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (chat_id, date) DO UPDATE SET
      words_learned = EXCLUDED.words_learned,
      words_in_progress = EXCLUDED.words_in_progress,
      reviews_today = EXCLUDED.reviews_today,
      new_words_today = EXCLUDED.new_words_today,
      tenses_practiced = EXCLUDED.tenses_practiced,
      streak_days = EXCLUDED.streak_days,
      updated_at = NOW()
    RETURNING *`,
    [
      chatId,
      date,
      vocabulary.words_learned,
      vocabulary.words_in_progress,
      reviews.reviews_today,
      vocabulary.new_words_today,
      reviews.tenses_practiced,
      streakDays,
    ]
  );

  return mapSpanishProgressRow(result.rows[0]);
}

export async function getLatestSpanishProgress(
  pool: pg.Pool,
  chatId: string
): Promise<SpanishProgressRow | null> {
  const result = await pool.query(
    `SELECT *
     FROM spanish_progress
     WHERE chat_id = $1
     ORDER BY date DESC
     LIMIT 1`,
    [chatId]
  );
  if (result.rows.length === 0) return null;
  return mapSpanishProgressRow(result.rows[0]);
}

// ============================================================================
// Spanish analytics queries
// ============================================================================

/**
 * Retention rate grouped by review interval bucket.
 * Buckets: 0-1d, 1-3d, 3-7d, 7-14d, 14-30d, 30d+
 * A review is "retained" if grade >= 3.
 */
export async function getRetentionByInterval(
  pool: pg.Pool,
  chatId: string
): Promise<RetentionBucketRow[]> {
  const result = await pool.query(
    `WITH bucketed AS (
      SELECT
        grade,
        CASE
          WHEN interval_days IS NULL OR interval_days <= 1 THEN '0-1d'
          WHEN interval_days <= 3 THEN '1-3d'
          WHEN interval_days <= 7 THEN '3-7d'
          WHEN interval_days <= 14 THEN '7-14d'
          WHEN interval_days <= 30 THEN '14-30d'
          ELSE '30d+'
        END AS bucket
      FROM spanish_reviews
      WHERE chat_id = $1
    )
    SELECT
      bucket AS interval_bucket,
      COUNT(*)::int AS total_reviews,
      COUNT(*) FILTER (WHERE grade >= 3)::int AS retained,
      CASE WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE grade >= 3))::float / COUNT(*)
        ELSE 0
      END AS retention_rate
    FROM bucketed
    GROUP BY bucket
    ORDER BY CASE bucket
      WHEN '0-1d' THEN 1 WHEN '1-3d' THEN 2 WHEN '3-7d' THEN 3
      WHEN '7-14d' THEN 4 WHEN '14-30d' THEN 5 ELSE 6
    END`,
    [chatId]
  );
  return result.rows.map((row) => ({
    interval_bucket: row.interval_bucket as string,
    total_reviews: Number(row.total_reviews),
    retained: Number(row.retained),
    retention_rate: parseFloat(row.retention_rate as string),
  }));
}

/**
 * Vocabulary funnel: count of words in each SRS state with median days spent.
 */
export async function getVocabularyFunnel(
  pool: pg.Pool,
  chatId: string
): Promise<VocabularyFunnelRow[]> {
  const result = await pool.query(
    `SELECT
      state,
      COUNT(*)::int AS count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (NOW() - first_seen)) / 86400.0
      )::float AS median_days_in_state
    FROM spanish_vocabulary
    WHERE chat_id = $1
    GROUP BY state
    ORDER BY CASE state
      WHEN 'new' THEN 1 WHEN 'learning' THEN 2
      WHEN 'review' THEN 3 WHEN 'relearning' THEN 4
    END`,
    [chatId]
  );
  return result.rows.map((row) => ({
    state: row.state as string,
    count: Number(row.count),
    /* v8 ignore next 3 */
    median_days_in_state: row.median_days_in_state != null
      ? parseFloat(row.median_days_in_state as string)
      : null,
  }));
}

/**
 * Daily average grade over a rolling window.
 */
export async function getGradeTrend(
  pool: pg.Pool,
  chatId: string,
  days: number
): Promise<GradeTrendRow[]> {
  const result = await pool.query(
    `SELECT
      reviewed_at::date::text AS date,
      AVG(grade)::float AS avg_grade,
      COUNT(*)::int AS review_count
    FROM spanish_reviews
    WHERE chat_id = $1
      AND reviewed_at >= NOW() - ($2 || ' days')::interval
    GROUP BY reviewed_at::date
    ORDER BY reviewed_at::date`,
    [chatId, days]
  );
  return result.rows.map((row) => ({
    date: row.date as string,
    avg_grade: parseFloat(row.avg_grade as string),
    review_count: Number(row.review_count),
  }));
}

/**
 * Daily lapse rate (% of reviews with grade <= 2) over a rolling window.
 */
export async function getLapseRateTrend(
  pool: pg.Pool,
  chatId: string,
  days: number
): Promise<LapseRateTrendRow[]> {
  const result = await pool.query(
    `SELECT
      reviewed_at::date::text AS date,
      CASE WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE grade <= 2))::float / COUNT(*)
        ELSE 0
      END AS lapse_rate,
      COUNT(*)::int AS review_count
    FROM spanish_reviews
    WHERE chat_id = $1
      AND reviewed_at >= NOW() - ($2 || ' days')::interval
    GROUP BY reviewed_at::date
    ORDER BY reviewed_at::date`,
    [chatId, days]
  );
  return result.rows.map((row) => ({
    date: row.date as string,
    lapse_rate: parseFloat(row.lapse_rate as string),
    review_count: Number(row.review_count),
  }));
}

/**
 * Historical progress snapshots for time-series display.
 */
export async function getProgressTimeSeries(
  pool: pg.Pool,
  chatId: string,
  days: number
): Promise<SpanishProgressRow[]> {
  const result = await pool.query(
    `SELECT *
    FROM spanish_progress
    WHERE chat_id = $1
      AND date >= (CURRENT_DATE - ($2 || ' days')::interval)
    ORDER BY date`,
    [chatId, days]
  );
  return result.rows.map(mapSpanishProgressRow);
}

/**
 * Review count and retention grouped by review_context (conversation, quiz, etc.).
 */
export async function getRetentionByContext(
  pool: pg.Pool,
  chatId: string
): Promise<{ context: string; total: number; retained: number; retention_rate: number }[]> {
  const result = await pool.query(
    `SELECT
      review_context AS context,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE grade >= 3)::int AS retained,
      CASE WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE grade >= 3))::float / COUNT(*)
        ELSE 0
      END AS retention_rate
    FROM spanish_reviews
    WHERE chat_id = $1
    GROUP BY review_context
    ORDER BY total DESC`,
    [chatId]
  );
  return result.rows.map((row) => ({
    context: row.context as string,
    total: Number(row.total),
    retained: Number(row.retained),
    retention_rate: parseFloat(row.retention_rate as string),
  }));
}

// ============================================================================
// Spanish assessment queries (LLM-as-judge)
// ============================================================================

export async function insertSpanishAssessment(
  pool: pg.Pool,
  params: {
    chatId: string;
    complexityScore: number;
    grammarScore: number;
    vocabularyScore: number;
    codeSwitchingRatio: number;
    overallScore: number;
    sampleMessageCount: number;
    rationale: string;
  }
): Promise<SpanishAssessmentRow> {
  const result = await pool.query(
    `INSERT INTO spanish_assessments (
      chat_id, complexity_score, grammar_score, vocabulary_score,
      code_switching_ratio, overall_score, sample_message_count, rationale
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      params.chatId,
      params.complexityScore,
      params.grammarScore,
      params.vocabularyScore,
      params.codeSwitchingRatio,
      params.overallScore,
      params.sampleMessageCount,
      params.rationale,
    ]
  );
  return mapSpanishAssessmentRow(result.rows[0]);
}

export async function getSpanishAssessments(
  pool: pg.Pool,
  chatId: string,
  days: number
): Promise<SpanishAssessmentRow[]> {
  const result = await pool.query(
    `SELECT *
    FROM spanish_assessments
    WHERE chat_id = $1
      AND assessed_at >= NOW() - ($2 || ' days')::interval
    ORDER BY assessed_at`,
    [chatId, days]
  );
  return result.rows.map(mapSpanishAssessmentRow);
}

export async function getLatestSpanishAssessment(
  pool: pg.Pool,
  chatId: string
): Promise<SpanishAssessmentRow | null> {
  const result = await pool.query(
    `SELECT *
    FROM spanish_assessments
    WHERE chat_id = $1
    ORDER BY assessed_at DESC
    LIMIT 1`,
    [chatId]
  );
  if (result.rows.length === 0) return null;
  return mapSpanishAssessmentRow(result.rows[0]);
}

// ============================================================================
// Mapper functions (private)
// ============================================================================

function mapSpanishProfileRow(row: Record<string, unknown>): SpanishProfileRow {
  return {
    chat_id: String(row.chat_id),
    cefr_level: (row.cefr_level as string | null) ?? null,
    known_tenses:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.known_tenses as string[]) || [],
    focus_topics:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.focus_topics as string[]) || [],
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function mapSpanishVerbRow(row: Record<string, unknown>): SpanishVerbRow {
  return {
    id: row.id as number,
    infinitive: row.infinitive as string,
    infinitive_english: (row.infinitive_english as string | null) ?? null,
    mood: row.mood as string,
    tense: row.tense as string,
    verb_english: (row.verb_english as string | null) ?? null,
    form_1s: (row.form_1s as string | null) ?? null,
    form_2s: (row.form_2s as string | null) ?? null,
    form_3s: (row.form_3s as string | null) ?? null,
    form_1p: (row.form_1p as string | null) ?? null,
    form_2p: (row.form_2p as string | null) ?? null,
    form_3p: (row.form_3p as string | null) ?? null,
    gerund: (row.gerund as string | null) ?? null,
    past_participle: (row.past_participle as string | null) ?? null,
    is_irregular: Boolean(row.is_irregular),
    source: row.source as string,
    created_at: row.created_at as Date,
  };
}

function mapSpanishVocabularyRow(row: Record<string, unknown>): SpanishVocabularyRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    word: row.word as string,
    translation: (row.translation as string | null) ?? null,
    part_of_speech: (row.part_of_speech as string | null) ?? null,
    region: (row.region as string) ?? "",
    example_sentence: (row.example_sentence as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    source: row.source as string,
    stability: parseFloat((row.stability as string) ?? "0"),
    difficulty: parseFloat((row.difficulty as string) ?? "0"),
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    state: row.state as SpanishVocabularyRow["state"],
    last_review: (row.last_review as Date | null) ?? null,
    next_review: (row.next_review as Date | null) ?? null,
    first_seen: row.first_seen as Date,
    last_seen: row.last_seen as Date,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function mapSpanishReviewRow(row: Record<string, unknown>): SpanishReviewRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    vocabulary_id: Number(row.vocabulary_id),
    grade: Number(row.grade),
    stability_before:
      row.stability_before == null ? null : parseFloat(row.stability_before as string),
    stability_after:
      row.stability_after == null ? null : parseFloat(row.stability_after as string),
    difficulty_before:
      row.difficulty_before == null ? null : parseFloat(row.difficulty_before as string),
    difficulty_after:
      row.difficulty_after == null ? null : parseFloat(row.difficulty_after as string),
    interval_days:
      row.interval_days == null ? null : parseFloat(row.interval_days as string),
    retrievability:
      row.retrievability == null ? null : parseFloat(row.retrievability as string),
    review_context: row.review_context as string,
    reviewed_at: row.reviewed_at as Date,
  };
}

function mapSpanishProgressRow(row: Record<string, unknown>): SpanishProgressRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    date: row.date as Date,
    words_learned: Number(row.words_learned),
    words_in_progress: Number(row.words_in_progress),
    reviews_today: Number(row.reviews_today),
    new_words_today: Number(row.new_words_today),
    tenses_practiced:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.tenses_practiced as string[]) || [],
    streak_days: Number(row.streak_days),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function mapSpanishAssessmentRow(row: Record<string, unknown>): SpanishAssessmentRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    complexity_score: parseFloat(row.complexity_score as string),
    grammar_score: parseFloat(row.grammar_score as string),
    vocabulary_score: parseFloat(row.vocabulary_score as string),
    code_switching_ratio: parseFloat(row.code_switching_ratio as string),
    overall_score: parseFloat(row.overall_score as string),
    sample_message_count: Number(row.sample_message_count),
    rationale: row.rationale as string,
    assessed_at: row.assessed_at as Date,
  };
}
