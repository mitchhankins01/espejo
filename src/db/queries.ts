import type pg from "pg";

// ============================================================================
// Result types
// ============================================================================

export interface MediaItem {
  type: "photo" | "video" | "audio";
  url: string;
  dimensions: { width: number; height: number } | null;
}

export interface EntryRow {
  id: number;
  uuid: string;
  text: string;
  created_at: Date;
  modified_at: Date | null;
  timezone: string | null;
  city: string | null;
  country: string | null;
  place_name: string | null;
  admin_area: string | null;
  latitude: number | null;
  longitude: number | null;
  temperature: number | null;
  weather_conditions: string | null;
  humidity: number | null;
  tags: string[];
  photo_count: number;
  video_count: number;
  audio_count: number;
  media: MediaItem[];
  weight_kg: number | null;
}

export type SearchResultRow = EntryRow & {
  rrf_score: number;
  has_semantic: boolean;
  has_fulltext: boolean;
};

export interface TagCountRow {
  name: string;
  count: number;
}

export type SimilarResultRow = EntryRow & {
  similarity_score: number;
};

export interface EntryStatsRow {
  total_entries: number;
  first_entry: Date;
  last_entry: Date;
  avg_word_count: number;
  total_word_count: number;
  entries_by_dow: Record<string, number>;
  entries_by_month: Record<string, number>;
  avg_entries_per_week: number;
  longest_streak_days: number;
  current_streak_days: number;
}

// ============================================================================
// Search filters
// ============================================================================

export interface SearchFilters {
  date_from?: string;
  date_to?: string;
  tags?: string[];
  city?: string;
}

// ============================================================================
// Query functions
// ============================================================================

/**
 * Hybrid RRF search combining semantic (cosine similarity) and BM25 (tsvector).
 * Both retrieval paths apply the same filters for consistency.
 */
export async function searchEntries(
  pool: pg.Pool,
  queryEmbedding: number[],
  queryText: string,
  filters: SearchFilters,
  limit: number
): Promise<SearchResultRow[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  // Build dynamic WHERE clauses
  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];
  let paramIdx = 3; // $1 = embedding, $2 = query text, $3 = limit

  if (filters.date_from) {
    paramIdx++;
    filterClauses.push(`e.created_at >= $${paramIdx}::timestamptz`);
    filterParams.push(filters.date_from);
  }
  if (filters.date_to) {
    paramIdx++;
    filterClauses.push(
      `e.created_at < ($${paramIdx}::date + interval '1 day')`
    );
    filterParams.push(filters.date_to);
  }
  if (filters.city) {
    paramIdx++;
    filterClauses.push(`e.city ILIKE $${paramIdx}`);
    filterParams.push(filters.city);
  }
  if (filters.tags && filters.tags.length > 0) {
    paramIdx++;
    filterClauses.push(
      `EXISTS (
        SELECT 1 FROM entry_tags et
        JOIN tags t ON t.id = et.tag_id
        WHERE et.entry_id = e.id AND t.name = ANY($${paramIdx}::text[])
      )`
    );
    filterParams.push(filters.tags);
  }

  const filterWhere =
    filterClauses.length > 0 ? "AND " + filterClauses.join(" AND ") : "";

  const sql = `
    WITH params AS (
      SELECT $1::vector AS query_embedding, plainto_tsquery('english', $2) AS ts_query
    ),
    semantic AS (
      SELECT e.id,
             ROW_NUMBER() OVER (ORDER BY e.embedding <=> p.query_embedding) AS rank_s
      FROM entries e, params p
      WHERE e.embedding IS NOT NULL
      ${filterWhere}
      ORDER BY e.embedding <=> p.query_embedding
      LIMIT 20
    ),
    fulltext AS (
      SELECT e.id,
             ROW_NUMBER() OVER (ORDER BY ts_rank(e.text_search, p.ts_query) DESC) AS rank_f
      FROM entries e, params p
      WHERE e.text_search @@ p.ts_query
      ${filterWhere}
      LIMIT 20
    )
    SELECT
      e.*,
      COALESCE(1.0 / (60 + s.rank_s), 0) + COALESCE(1.0 / (60 + f.rank_f), 0) AS rrf_score,
      s.id IS NOT NULL AS has_semantic,
      f.id IS NOT NULL AS has_fulltext,
      COALESCE(
        (SELECT array_agg(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id),
        '{}'::text[]
      ) AS tags,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count,
      (SELECT COALESCE(json_agg(json_build_object(
        'type', m.type, 'url', m.url, 'dimensions', m.dimensions
      ) ORDER BY m.id) FILTER (WHERE m.url IS NOT NULL), '[]'::json)
      FROM media m WHERE m.entry_id = e.id) AS media,
      dm.weight_kg
    FROM entries e
    LEFT JOIN semantic s ON e.id = s.id
    LEFT JOIN fulltext f ON e.id = f.id
    LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date
    WHERE s.id IS NOT NULL OR f.id IS NOT NULL
    ORDER BY rrf_score DESC
    LIMIT $3
  `;

  const result = await pool.query(sql, [
    embeddingStr,
    queryText,
    limit,
    ...filterParams,
  ]);

  return result.rows.map((row) => ({
    ...mapEntryRow(row),
    rrf_score: parseFloat(row.rrf_score),
    has_semantic: row.has_semantic,
    has_fulltext: row.has_fulltext,
  }));
}

/**
 * Get a single entry by UUID with full metadata, tags, and media counts.
 */
export async function getEntryByUuid(
  pool: pg.Pool,
  uuid: string
): Promise<EntryRow | null> {
  const result = await pool.query(
    `SELECT
      e.*,
      COALESCE(
        (SELECT array_agg(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id),
        '{}'::text[]
      ) AS tags,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count,
      (SELECT COALESCE(json_agg(json_build_object(
        'type', m.type, 'url', m.url, 'dimensions', m.dimensions
      ) ORDER BY m.id) FILTER (WHERE m.url IS NOT NULL), '[]'::json)
      FROM media m WHERE m.entry_id = e.id) AS media,
      dm.weight_kg
    FROM entries e
    LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date
    WHERE e.uuid = $1`,
    [uuid]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    uuid: row.uuid,
    text: row.text,
    created_at: row.created_at,
    modified_at: row.modified_at,
    timezone: row.timezone,
    city: row.city,
    country: row.country,
    place_name: row.place_name,
    admin_area: row.admin_area,
    latitude: row.latitude,
    longitude: row.longitude,
    temperature: row.temperature,
    weather_conditions: row.weather_conditions,
    humidity: row.humidity,
    tags: /* v8 ignore next -- defensive: SQL coalesces to '{}' */ row.tags || [],
    photo_count: row.photo_count,
    video_count: row.video_count,
    audio_count: row.audio_count,
    media: /* v8 ignore next -- defensive: SQL coalesces to '[]' */ row.media || [],
    weight_kg: row.weight_kg != null ? parseFloat(row.weight_kg) : null,
  };
}

/**
 * Get entries within a date range, ordered chronologically.
 */
export async function getEntriesByDateRange(
  pool: pg.Pool,
  dateFrom: string,
  dateTo: string,
  limit: number
): Promise<EntryRow[]> {
  const result = await pool.query(
    `SELECT
      e.*,
      COALESCE(
        (SELECT array_agg(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id),
        '{}'::text[]
      ) AS tags,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count,
      dm.weight_kg
    FROM entries e
    LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date
    WHERE e.created_at >= $1::timestamptz
      AND e.created_at < ($2::date + interval '1 day')
    ORDER BY e.created_at ASC
    LIMIT $3`,
    [dateFrom, dateTo, limit]
  );

  return result.rows.map(mapEntryRow);
}

/**
 * Find entries written on a specific MM-DD across all years.
 */
export async function getEntriesOnThisDay(
  pool: pg.Pool,
  month: number,
  day: number
): Promise<EntryRow[]> {
  const result = await pool.query(
    `SELECT
      e.*,
      COALESCE(
        (SELECT array_agg(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id),
        '{}'::text[]
      ) AS tags,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count,
      dm.weight_kg
    FROM entries e
    LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date
    WHERE EXTRACT(MONTH FROM e.created_at) = $1
      AND EXTRACT(DAY FROM e.created_at) = $2
    ORDER BY e.created_at ASC`,
    [month, day]
  );

  return result.rows.map(mapEntryRow);
}

/**
 * Find entries semantically similar to a given entry using cosine similarity.
 */
export async function findSimilarEntries(
  pool: pg.Pool,
  uuid: string,
  limit: number
): Promise<SimilarResultRow[]> {
  const result = await pool.query(
    `WITH source AS (
      SELECT id, embedding FROM entries WHERE uuid = $1
    )
    SELECT
      e.*,
      1 - (e.embedding <=> s.embedding) AS similarity_score,
      COALESCE(
        (SELECT array_agg(t.name) FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id),
        '{}'::text[]
      ) AS tags,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
      (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count,
      (SELECT COALESCE(json_agg(json_build_object(
        'type', m.type, 'url', m.url, 'dimensions', m.dimensions
      ) ORDER BY m.id) FILTER (WHERE m.url IS NOT NULL), '[]'::json)
      FROM media m WHERE m.entry_id = e.id) AS media,
      dm.weight_kg
    FROM entries e
    CROSS JOIN source s
    LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date
    WHERE e.id != s.id
      AND e.embedding IS NOT NULL
    ORDER BY e.embedding <=> s.embedding
    LIMIT $2`,
    [uuid, limit]
  );

  return result.rows.map((row) => ({
    ...mapEntryRow(row),
    similarity_score: parseFloat(row.similarity_score),
  }));
}

/**
 * List all tags with usage counts, ordered by frequency.
 */
export async function listTags(pool: pg.Pool): Promise<TagCountRow[]> {
  const result = await pool.query(
    `SELECT t.name, COUNT(et.entry_id)::int AS count
     FROM tags t
     JOIN entry_tags et ON et.tag_id = t.id
     GROUP BY t.id, t.name
     ORDER BY count DESC, t.name ASC`
  );

  return result.rows;
}

/**
 * Get writing statistics with optional date range filter.
 */
export async function getEntryStats(
  pool: pg.Pool,
  dateFrom?: string,
  dateTo?: string
): Promise<EntryStatsRow> {
  const filterClauses: string[] = [];
  const params: unknown[] = [];

  if (dateFrom) {
    params.push(dateFrom);
    filterClauses.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (dateTo) {
    params.push(dateTo);
    filterClauses.push(
      `created_at < ($${params.length}::date + interval '1 day')`
    );
  }

  const whereClause =
    filterClauses.length > 0 ? "WHERE " + filterClauses.join(" AND ") : "";

  // Main stats
  const statsResult = await pool.query(
    `SELECT
      COUNT(*)::int AS total_entries,
      MIN(created_at) AS first_entry,
      MAX(created_at) AS last_entry,
      COALESCE(AVG(array_length(regexp_split_to_array(COALESCE(text, ''), '\\s+'), 1)), 0)::int AS avg_word_count,
      COALESCE(SUM(array_length(regexp_split_to_array(COALESCE(text, ''), '\\s+'), 1)), 0)::int AS total_word_count
    FROM entries
    ${whereClause}`,
    params
  );

  // By day of week
  const dowResult = await pool.query(
    `SELECT
      TRIM(to_char(created_at, 'Day')) AS dow,
      COUNT(*)::int AS count
    FROM entries
    ${whereClause}
    GROUP BY dow, EXTRACT(DOW FROM created_at)
    ORDER BY EXTRACT(DOW FROM created_at)`,
    params
  );

  // By month
  const monthResult = await pool.query(
    `SELECT
      TRIM(to_char(created_at, 'Month')) AS month,
      COUNT(*)::int AS count
    FROM entries
    ${whereClause}
    GROUP BY month, EXTRACT(MONTH FROM created_at)
    ORDER BY EXTRACT(MONTH FROM created_at)`,
    params
  );

  // Streaks
  const streakResult = await pool.query(
    `WITH entry_dates AS (
      SELECT DISTINCT created_at::date AS entry_date
      FROM entries
      ${whereClause}
    ),
    date_groups AS (
      SELECT
        entry_date,
        entry_date - (ROW_NUMBER() OVER (ORDER BY entry_date))::int AS grp
      FROM entry_dates
    ),
    streaks AS (
      SELECT
        grp,
        COUNT(*)::int AS streak_length,
        MAX(entry_date) AS streak_end
      FROM date_groups
      GROUP BY grp
    )
    SELECT
      COALESCE(MAX(streak_length), 0) AS longest_streak,
      COALESCE(
        (SELECT streak_length FROM streaks WHERE streak_end >= CURRENT_DATE - interval '1 day' ORDER BY streak_end DESC LIMIT 1),
        0
      ) AS current_streak
    FROM streaks`,
    params
  );

  // Average entries per week
  const stats = statsResult.rows[0];
  let avgPerWeek = 0;
  if (stats.first_entry && stats.last_entry) {
    const diffMs =
      new Date(stats.last_entry).getTime() -
      new Date(stats.first_entry).getTime();
    const weeks = Math.max(diffMs / (7 * 24 * 60 * 60 * 1000), 1);
    avgPerWeek = Math.round((stats.total_entries / weeks) * 10) / 10;
  }

  const entriesByDow: Record<string, number> = {};
  for (const row of dowResult.rows) {
    entriesByDow[row.dow] = row.count;
  }

  const entriesByMonth: Record<string, number> = {};
  for (const row of monthResult.rows) {
    entriesByMonth[row.month] = row.count;
  }

  return {
    total_entries: stats.total_entries,
    first_entry: stats.first_entry,
    last_entry: stats.last_entry,
    avg_word_count: stats.avg_word_count,
    total_word_count: stats.total_word_count,
    entries_by_dow: entriesByDow,
    entries_by_month: entriesByMonth,
    avg_entries_per_week: avgPerWeek,
    /* v8 ignore next 2 -- defensive: streak query always returns a row */
    longest_streak_days: streakResult.rows[0]?.longest_streak ?? 0,
    current_streak_days: streakResult.rows[0]?.current_streak ?? 0,
  };
}

/**
 * Upsert a daily metric (weight). Used by the HTTP /api/metrics endpoint.
 */
export async function upsertDailyMetric(
  pool: pg.Pool,
  date: string,
  weightKg: number
): Promise<void> {
  await pool.query(
    `INSERT INTO daily_metrics (date, weight_kg)
     VALUES ($1::date, $2)
     ON CONFLICT (date) DO UPDATE SET weight_kg = EXCLUDED.weight_kg`,
    [date, weightKg]
  );
}

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
      COALESCE(SUM((reviewed_at::date = CURRENT_DATE)::int), 0)::int AS reviews_today,
      COALESCE(AVG(grade)::float, 0)::float AS average_grade
     FROM spanish_reviews
     WHERE chat_id = $1`,
    [chatId]
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
      COALESCE(SUM((first_seen::date = $2::date)::int), 0)::int AS new_words_today
     FROM spanish_vocabulary
     WHERE chat_id = $1`,
    [chatId, date]
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
       AND reviewed_at::date = $2::date`,
    [chatId, date]
  );

  const streakResult = await pool.query(
    `WITH activity_days AS (
      SELECT DISTINCT reviewed_at::date AS day
      FROM spanish_reviews
      WHERE chat_id = $1 AND reviewed_at::date <= $2::date
      UNION
      SELECT DISTINCT first_seen::date AS day
      FROM spanish_vocabulary
      WHERE chat_id = $1 AND first_seen::date <= $2::date
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
    [chatId, date]
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
// Chat message types and queries
// ============================================================================

export interface ChatMessageRow {
  id: number;
  chat_id: string;
  external_message_id: string | null;
  role: string;
  content: string;
  tool_call_id: string | null;
  compacted_at: Date | null;
  created_at: Date;
}

export interface ChatSoulStateRow {
  chat_id: string;
  identity_summary: string;
  relational_commitments: string[];
  tone_signature: string[];
  growth_notes: string[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface PatternRow {
  id: number;
  content: string;
  kind: string;
  confidence: number;
  strength: number;
  times_seen: number;
  status: string;
  temporal: Record<string, unknown> | null;
  canonical_hash: string | null;
  source_type: string;
  source_id: string | null;
  expires_at: Date | null;
  first_seen: Date;
  last_seen: Date;
  created_at: Date;
}

export interface PatternSearchRow extends PatternRow {
  score: number;
  similarity: number;
}

export interface ApiUsageSummaryRow {
  purpose: string;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

export interface CostNotificationRow {
  id: number;
  chat_id: string;
  window_start: Date;
  window_end: Date;
  cost_usd: number;
  created_at: Date;
}

export interface SoulQualitySignalRow {
  id: number;
  chat_id: string;
  assistant_message_id: number | null;
  signal_type: string;
  soul_version: number;
  pattern_count: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface SoulQualityStats {
  felt_personal: number;
  felt_generic: number;
  correction: number;
  positive_reaction: number;
  total: number;
  personal_ratio: number;
}

/**
 * Insert a chat message. Returns false if duplicate (via external_message_id UNIQUE).
 */
export async function insertChatMessage(
  pool: pg.Pool,
  params: {
    chatId: string;
    externalMessageId: string | null;
    role: string;
    content: string;
    toolCallId?: string | null;
  }
): Promise<{ inserted: boolean; id: number | null }> {
  const result = await pool.query(
    `INSERT INTO chat_messages (chat_id, external_message_id, role, content, tool_call_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (external_message_id) DO NOTHING
     RETURNING id`,
    [
      params.chatId,
      params.externalMessageId,
      params.role,
      params.content,
      params.toolCallId ?? null,
    ]
  );
  return {
    inserted: result.rowCount !== null && result.rowCount > 0,
    id: result.rows[0]?.id ?? null,
  };
}

/**
 * Get recent uncompacted messages, ordered oldest first.
 */
export async function getRecentMessages(
  pool: pg.Pool,
  chatId: string,
  limit: number
): Promise<ChatMessageRow[]> {
  const result = await pool.query(
    `SELECT *
     FROM (
       SELECT *
       FROM chat_messages
       WHERE chat_id = $1 AND compacted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     ) AS recent
     ORDER BY created_at ASC, id ASC`,
    [chatId, limit]
  );
  return result.rows;
}

/**
 * Soft-delete messages by marking them as compacted.
 */
export async function markMessagesCompacted(
  pool: pg.Pool,
  ids: number[]
): Promise<void> {
  await pool.query(
    `UPDATE chat_messages SET compacted_at = NOW() WHERE id = ANY($1::int[])`,
    [ids]
  );
}

/**
 * Hard-delete compacted messages older than the given timestamp.
 */
export async function purgeCompactedMessages(
  pool: pg.Pool,
  olderThan: Date
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM chat_messages WHERE compacted_at IS NOT NULL AND compacted_at < $1`,
    [olderThan]
  );
  return /* v8 ignore next -- defensive: rowCount is always set for DELETE */ result.rowCount ?? 0;
}

/**
 * Get the most recent compaction timestamp for a chat.
 */
export async function getLastCompactionTime(
  pool: pg.Pool,
  chatId: string
): Promise<Date | null> {
  const result = await pool.query(
    `SELECT MAX(compacted_at) AS last_compacted FROM chat_messages WHERE chat_id = $1 AND compacted_at IS NOT NULL`,
    [chatId]
  );
  return result.rows[0]?.last_compacted ?? null;
}

/**
 * Get the persistent soul state for a chat.
 */
export async function getSoulState(
  pool: pg.Pool,
  chatId: string
): Promise<ChatSoulStateRow | null> {
  const result = await pool.query(
    `SELECT *
     FROM chat_soul_state
     WHERE chat_id = $1
     LIMIT 1`,
    [chatId]
  );
  if (result.rows.length === 0) return null;
  return mapSoulStateRow(result.rows[0]);
}

/**
 * Insert or update a chat's soul state. On update, version auto-increments.
 */
export async function upsertSoulState(
  pool: pg.Pool,
  params: {
    chatId: string;
    identitySummary: string;
    relationalCommitments: string[];
    toneSignature: string[];
    growthNotes: string[];
    version?: number;
  }
): Promise<ChatSoulStateRow> {
  const version = Math.max(1, params.version ?? 1);
  const result = await pool.query(
    `INSERT INTO chat_soul_state (
       chat_id,
       identity_summary,
       relational_commitments,
       tone_signature,
       growth_notes,
       version
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chat_id) DO UPDATE SET
       identity_summary = EXCLUDED.identity_summary,
       relational_commitments = EXCLUDED.relational_commitments,
       tone_signature = EXCLUDED.tone_signature,
       growth_notes = EXCLUDED.growth_notes,
       version = GREATEST(chat_soul_state.version + 1, EXCLUDED.version),
       updated_at = NOW()
     RETURNING *`,
    [
      params.chatId,
      params.identitySummary,
      params.relationalCommitments,
      params.toneSignature,
      params.growthNotes,
      version,
    ]
  );
  return mapSoulStateRow(result.rows[0]);
}

// ============================================================================
// Pattern queries
// ============================================================================

/**
 * Insert a new pattern with embedding and canonical hash.
 */
export async function insertPattern(
  pool: pg.Pool,
  params: {
    content: string;
    kind: string;
    confidence: number;
    embedding: number[] | null;
    temporal: Record<string, unknown> | null;
    canonicalHash: string;
    sourceType?: string;
    sourceId?: string | null;
    expiresAt?: Date | null;
    timestamp: Date;
  }
): Promise<PatternRow> {
  const embeddingStr = params.embedding
    ? `[${params.embedding.join(",")}]`
    : null;
  const result = await pool.query(
    `INSERT INTO patterns (
      content, kind, confidence, embedding, temporal, canonical_hash,
      source_type, source_id, expires_at, first_seen, last_seen
    )
     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10, $10)
     RETURNING *`,
    [
      params.content,
      params.kind,
      params.confidence,
      embeddingStr,
      params.temporal ? JSON.stringify(params.temporal) : null,
      params.canonicalHash,
      params.sourceType ?? "compaction",
      params.sourceId ?? null,
      params.expiresAt ?? null,
      params.timestamp,
    ]
  );
  return mapPatternRow(result.rows[0]);
}

/**
 * Reinforce an existing pattern with spacing-sensitive boost.
 * boost = boost_max * (1 - e^(-days_since_last_seen / kappa))
 */
export async function reinforcePattern(
  pool: pg.Pool,
  id: number,
  confidence: number
): Promise<PatternRow> {
  const result = await pool.query(
    `UPDATE patterns SET
       times_seen = times_seen + 1,
       strength = LEAST(
         strength + 1.0 * (1.0 - EXP(-EXTRACT(EPOCH FROM (NOW() - last_seen)) / 86400.0 / 7.0)),
         20.0
       ),
       confidence = $2,
       last_seen = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, confidence]
  );
  return mapPatternRow(result.rows[0]);
}

/**
 * Deprecate a pattern (set status to 'deprecated').
 */
export async function deprecatePattern(
  pool: pg.Pool,
  id: number
): Promise<void> {
  await pool.query(
    `UPDATE patterns SET status = 'deprecated' WHERE id = $1`,
    [id]
  );
}

/**
 * Update a pattern's status (e.g. 'superseded', 'disputed').
 */
export async function updatePatternStatus(
  pool: pg.Pool,
  id: number,
  status: string
): Promise<void> {
  await pool.query(`UPDATE patterns SET status = $2 WHERE id = $1`, [
    id,
    status,
  ]);
}

/**
 * Find similar patterns by cosine similarity (for dedup).
 * Returns patterns with similarity >= minSimilarity.
 */
export async function findSimilarPatterns(
  pool: pg.Pool,
  embedding: number[],
  limit: number,
  minSimilarity: number
): Promise<(PatternRow & { similarity: number })[]> {
  const embeddingStr = `[${embedding.join(",")}]`;
  const result = await pool.query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS similarity
     FROM patterns
     WHERE status = 'active' AND embedding IS NOT NULL
       AND (expires_at IS NULL OR expires_at > NOW())
       AND 1 - (embedding <=> $1::vector) >= $3
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [embeddingStr, limit, minSimilarity]
  );
  return result.rows.map((row) => ({
    ...mapPatternRow(row),
    similarity: parseFloat(row.similarity),
  }));
}

/**
 * Search patterns with typed-decay ranking.
 * score = similarity * recency * memory * confidence * validity
 */
export async function searchPatterns(
  pool: pg.Pool,
  queryEmbedding: number[],
  limit: number,
  minSimilarity: number = 0.4
): Promise<PatternSearchRow[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const result = await pool.query(
    `WITH scored AS (
      SELECT *,
        1 - (embedding <=> $1::vector) AS sim,
        CASE kind
          WHEN 'behavior' THEN 90 WHEN 'belief' THEN 90 WHEN 'goal' THEN 60
          WHEN 'preference' THEN 90 WHEN 'emotion' THEN 14
          WHEN 'temporal' THEN 365 WHEN 'causal' THEN 90
          WHEN 'fact' THEN 3650 WHEN 'event' THEN 60 ELSE 90
        END AS half_life,
        CASE kind
          WHEN 'behavior' THEN 0.45 WHEN 'belief' THEN 0.45 WHEN 'goal' THEN 0.35
          WHEN 'preference' THEN 0.45 WHEN 'emotion' THEN 0.15
          WHEN 'temporal' THEN 0.60 WHEN 'causal' THEN 0.45
          WHEN 'fact' THEN 0.85 WHEN 'event' THEN 0.25 ELSE 0.45
        END AS floor_val,
        CASE status
          WHEN 'active' THEN 1.0 WHEN 'disputed' THEN 0.5 ELSE 0.0
        END AS validity
      FROM patterns
      WHERE embedding IS NOT NULL AND status IN ('active', 'disputed')
        AND (expires_at IS NULL OR expires_at > NOW())
        AND 1 - (embedding <=> $1::vector) >= $3
    )
    SELECT *,
      sim
      * (floor_val + (1.0 - floor_val) * EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - last_seen)) / 86400.0 / half_life))
      * (1.0 + 0.25 * LEAST(LN(1.0 + strength), 2.0))
      * confidence
      * validity
      AS score
    FROM scored
    ORDER BY score DESC
    LIMIT $2`,
    [embeddingStr, limit, minSimilarity]
  );
  return result.rows.map((row) => ({
    ...mapPatternRow(row),
    score: parseFloat(row.score),
    similarity: parseFloat(row.sim),
  }));
}

/**
 * Get active preference/fact patterns describing language preferences.
 * These are used as always-on communication anchors in chat prompts.
 */
export async function getLanguagePreferencePatterns(
  pool: pg.Pool,
  limit: number
): Promise<PatternRow[]> {
  const result = await pool.query(
    `SELECT * FROM patterns
     WHERE status = 'active'
       AND kind IN ('preference', 'fact')
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (
         content ILIKE '%language%'
         OR content ILIKE '%english%'
         OR content ILIKE '%dutch%'
         OR content ILIKE '%nederlands%'
         OR content ILIKE '%spanish%'
         OR content ILIKE '%espanol%'
         OR content ILIKE '%español%'
         OR content ILIKE '%idioma%'
       )
     ORDER BY
       CASE WHEN kind = 'preference' THEN 0 ELSE 1 END,
       strength DESC,
       confidence DESC,
       last_seen DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapPatternRow);
}

/**
 * Get top patterns by strength (for compaction context, no embedding needed).
 */
export async function getTopPatterns(
  pool: pg.Pool,
  limit: number
): Promise<PatternRow[]> {
  const result = await pool.query(
    `SELECT * FROM patterns
     WHERE status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY strength DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapPatternRow);
}

/**
 * Mark expired event patterns as deprecated.
 */
export async function pruneExpiredEventPatterns(
  pool: pg.Pool
): Promise<number> {
  const result = await pool.query(
    `UPDATE patterns
     SET status = 'deprecated'
     WHERE kind = 'event'
       AND status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`
  );
  return result.rowCount ?? 0;
}

/**
 * Count active event patterns that are now stale (expired), without mutating.
 */
export async function countStaleEventPatterns(
  pool: pg.Pool
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM patterns
     WHERE kind = 'event'
       AND status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`
  );
  return result.rows[0]?.count ?? 0;
}

// ============================================================================
// Pattern supporting queries
// ============================================================================

export async function insertPatternObservation(
  pool: pg.Pool,
  params: {
    patternId: number;
    chatMessageIds: number[];
    evidence: string;
    evidenceRoles: string[];
    confidence: number;
    sourceType?: string;
    sourceId?: string | null;
  }
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO pattern_observations (
      pattern_id, chat_message_ids, evidence, evidence_roles, confidence, source_type, source_id
    )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      params.patternId,
      params.chatMessageIds,
      params.evidence,
      params.evidenceRoles,
      params.confidence,
      params.sourceType ?? "chat_compaction",
      params.sourceId ?? null,
    ]
  );
  return result.rows[0].id as number;
}

export async function insertPatternRelation(
  pool: pg.Pool,
  fromId: number,
  toId: number,
  relation: string
): Promise<void> {
  await pool.query(
    `INSERT INTO pattern_relations (from_pattern_id, to_pattern_id, relation)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_pattern_id, to_pattern_id, relation) DO NOTHING`,
    [fromId, toId, relation]
  );
}

export async function insertPatternAlias(
  pool: pg.Pool,
  patternId: number,
  content: string,
  embedding: number[] | null
): Promise<void> {
  const embeddingStr = embedding ? `[${embedding.join(",")}]` : null;
  await pool.query(
    `INSERT INTO pattern_aliases (pattern_id, content, embedding)
     VALUES ($1, $2, $3::vector)`,
    [patternId, content, embeddingStr]
  );
}

export async function linkPatternToEntry(
  pool: pg.Pool,
  patternId: number,
  entryUuid: string,
  source: string,
  confidence: number
): Promise<void> {
  await pool.query(
    `INSERT INTO pattern_entries (pattern_id, entry_uuid, source, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pattern_id, entry_uuid) DO UPDATE SET
       times_linked = pattern_entries.times_linked + 1,
       last_linked_at = NOW()`,
    [patternId, entryUuid, source, confidence]
  );
}

// ============================================================================
// API usage tracking
// ============================================================================

export async function logApiUsage(
  pool: pg.Pool,
  params: {
    provider: string;
    model: string;
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    durationSeconds?: number;
    costUsd: number;
    latencyMs?: number;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO api_usage (provider, model, purpose, input_tokens, output_tokens, duration_seconds, cost_usd, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.provider,
      params.model,
      params.purpose,
      params.inputTokens,
      params.outputTokens,
      params.durationSeconds ?? null,
      params.costUsd,
      params.latencyMs ?? null,
    ]
  );
}

export async function getUsageSummary(
  pool: pg.Pool,
  since: Date
): Promise<ApiUsageSummaryRow[]> {
  const result = await pool.query(
    `SELECT
       purpose,
       COUNT(*)::int AS total_calls,
       SUM(input_tokens)::int AS total_input_tokens,
       SUM(output_tokens)::int AS total_output_tokens,
       SUM(cost_usd)::float AS total_cost_usd
     FROM api_usage
     WHERE created_at >= $1
     GROUP BY purpose
     ORDER BY total_cost_usd DESC`,
    [since]
  );
  return result.rows;
}

export async function getTotalApiCostSince(
  pool: pg.Pool,
  since: Date,
  until: Date
): Promise<number> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost
     FROM api_usage
     WHERE created_at >= $1 AND created_at <= $2`,
    [since, until]
  );
  return result.rows[0]?.total_cost ?? 0;
}

export async function getLastCostNotificationTime(
  pool: pg.Pool,
  chatId: string
): Promise<Date | null> {
  const result = await pool.query(
    `SELECT created_at
     FROM cost_notifications
     WHERE chat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
  return result.rows[0]?.created_at ?? null;
}

export async function insertCostNotification(
  pool: pg.Pool,
  params: {
    chatId: string;
    windowStart: Date;
    windowEnd: Date;
    costUsd: number;
  }
): Promise<CostNotificationRow> {
  const result = await pool.query(
    `INSERT INTO cost_notifications (chat_id, window_start, window_end, cost_usd)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.chatId, params.windowStart, params.windowEnd, params.costUsd]
  );
  const row = result.rows[0];
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    window_start: row.window_start as Date,
    window_end: row.window_end as Date,
    cost_usd: parseFloat(row.cost_usd as string),
    created_at: row.created_at as Date,
  };
}

export async function logMemoryRetrieval(
  pool: pg.Pool,
  params: {
    chatId: string;
    queryText: string;
    queryHash: string;
    degraded: boolean;
    patternIds: number[];
    patternKinds: string[];
    topScore: number | null;
  }
): Promise<void> {
  const alignedKinds = params.patternIds.map(
    (_id, idx) => params.patternKinds[idx] ?? "unknown"
  );

  await pool.query(
    `INSERT INTO memory_retrieval_logs (
      chat_id, query_text, query_hash, degraded, pattern_ids, pattern_kinds, top_score
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.chatId,
      params.queryText,
      params.queryHash,
      params.degraded,
      params.patternIds,
      alignedKinds,
      params.topScore,
    ]
  );
}

// ============================================================================
// Soul quality signals
// ============================================================================

/**
 * Insert a soul quality feedback signal.
 */
export async function insertSoulQualitySignal(
  pool: pg.Pool,
  params: {
    chatId: string;
    assistantMessageId: number | null;
    signalType: string;
    soulVersion: number;
    patternCount: number;
    metadata: Record<string, unknown>;
  }
): Promise<SoulQualitySignalRow> {
  const result = await pool.query(
    `INSERT INTO soul_quality_signals (
      chat_id, assistant_message_id, signal_type, soul_version, pattern_count, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      params.chatId,
      params.assistantMessageId,
      params.signalType,
      params.soulVersion,
      params.patternCount,
      JSON.stringify(params.metadata),
    ]
  );
  return mapSoulQualitySignalRow(result.rows[0]);
}

/**
 * Get aggregated soul quality stats for a chat within a time window.
 */
export async function getSoulQualityStats(
  pool: pg.Pool,
  chatId: string,
  windowDays: number = 30
): Promise<SoulQualityStats> {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN signal_type = 'felt_personal' THEN 1 ELSE 0 END), 0)::int AS felt_personal,
       COALESCE(SUM(CASE WHEN signal_type = 'felt_generic' THEN 1 ELSE 0 END), 0)::int AS felt_generic,
       COALESCE(SUM(CASE WHEN signal_type = 'correction' THEN 1 ELSE 0 END), 0)::int AS correction,
       COALESCE(SUM(CASE WHEN signal_type = 'positive_reaction' THEN 1 ELSE 0 END), 0)::int AS positive_reaction,
       COUNT(*)::int AS total
     FROM soul_quality_signals
     WHERE chat_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
    [chatId, windowDays]
  );
  const row = result.rows[0];
  const positiveSignals = row.felt_personal + row.positive_reaction;
  const negativeSignals = row.felt_generic;
  const qualityTotal = positiveSignals + negativeSignals;
  return {
    felt_personal: row.felt_personal,
    felt_generic: row.felt_generic,
    correction: row.correction,
    positive_reaction: row.positive_reaction,
    total: row.total,
    personal_ratio: qualityTotal > 0 ? positiveSignals / qualityTotal : 0,
  };
}

/**
 * Get the most recent assistant message ID for a chat (for attaching feedback signals).
 */
export async function getLastAssistantMessageId(
  pool: pg.Pool,
  chatId: string
): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM chat_messages
     WHERE chat_id = $1 AND role = 'assistant' AND compacted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
  return result.rows[0]?.id ?? null;
}

// ============================================================================
// Pulse checks (Phase 5: self-healing organism)
// ============================================================================

export interface PulseCheckRow {
  id: number;
  chat_id: string;
  status: string;
  personal_ratio: number;
  correction_rate: number;
  signal_counts: Record<string, number>;
  repairs_applied: Record<string, unknown>[];
  soul_version_before: number;
  soul_version_after: number;
  created_at: Date;
}

/**
 * Insert a pulse check diagnosis record.
 */
export async function insertPulseCheck(
  pool: pg.Pool,
  params: {
    chatId: string;
    status: string;
    personalRatio: number;
    correctionRate: number;
    signalCounts: Record<string, number>;
    repairsApplied: Record<string, unknown>[];
    soulVersionBefore: number;
    soulVersionAfter: number;
  }
): Promise<PulseCheckRow> {
  const result = await pool.query(
    `INSERT INTO pulse_checks (
      chat_id, status, personal_ratio, correction_rate,
      signal_counts, repairs_applied, soul_version_before, soul_version_after
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      params.chatId,
      params.status,
      params.personalRatio,
      params.correctionRate,
      JSON.stringify(params.signalCounts),
      JSON.stringify(params.repairsApplied),
      params.soulVersionBefore,
      params.soulVersionAfter,
    ]
  );
  return mapPulseCheckRow(result.rows[0]);
}

/**
 * Get the most recent pulse check time for a chat.
 */
export async function getLastPulseCheckTime(
  pool: pg.Pool,
  chatId: string
): Promise<Date | null> {
  const result = await pool.query(
    `SELECT created_at FROM pulse_checks
     WHERE chat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
  return result.rows[0]?.created_at ?? null;
}

/**
 * Get the most recent pulse check for a chat (for /soul display).
 */
export async function getLastPulseCheck(
  pool: pg.Pool,
  chatId: string
): Promise<PulseCheckRow | null> {
  const result = await pool.query(
    `SELECT * FROM pulse_checks
     WHERE chat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
  if (result.rows.length === 0) return null;
  return mapPulseCheckRow(result.rows[0]);
}

// ============================================================================
// Soul state history (Phase 5: audit trail)
// ============================================================================

export interface SoulStateHistoryRow {
  id: number;
  chat_id: string;
  version: number;
  identity_summary: string;
  relational_commitments: string[];
  tone_signature: string[];
  growth_notes: string[];
  change_reason: string;
  created_at: Date;
}

/**
 * Record a soul state snapshot for the audit trail.
 */
export async function insertSoulStateHistory(
  pool: pg.Pool,
  params: {
    chatId: string;
    version: number;
    identitySummary: string;
    relationalCommitments: string[];
    toneSignature: string[];
    growthNotes: string[];
    changeReason: string;
  }
): Promise<SoulStateHistoryRow> {
  const result = await pool.query(
    `INSERT INTO soul_state_history (
      chat_id, version, identity_summary, relational_commitments,
      tone_signature, growth_notes, change_reason
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      params.chatId,
      params.version,
      params.identitySummary,
      params.relationalCommitments,
      params.toneSignature,
      params.growthNotes,
      params.changeReason,
    ]
  );
  return mapSoulStateHistoryRow(result.rows[0]);
}

// ============================================================================
// Activity logs
// ============================================================================

export interface ActivityLogRow {
  id: number;
  chat_id: string;
  memories: ActivityLogMemory[];
  tool_calls: ActivityLogToolCall[];
  cost_usd: number | null;
  created_at: Date;
}

export interface ActivityLogMemory {
  id: number;
  content: string;
  kind: string;
  confidence: number;
  score: number;
}

export interface ActivityLogToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  truncated_result: string;
}

/**
 * Insert an activity log for a single agent run.
 */
export async function insertActivityLog(
  pool: pg.Pool,
  params: {
    chatId: string;
    memories: ActivityLogMemory[];
    toolCalls: ActivityLogToolCall[];
    costUsd: number | null;
  }
): Promise<ActivityLogRow> {
  const result = await pool.query(
    `INSERT INTO activity_logs (chat_id, memories, tool_calls, cost_usd)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      params.chatId,
      JSON.stringify(params.memories),
      JSON.stringify(params.toolCalls),
      params.costUsd,
    ]
  );
  return mapActivityLogRow(result.rows[0]);
}

/**
 * Get a single activity log by ID.
 */
export async function getActivityLog(
  pool: pg.Pool,
  id: number
): Promise<ActivityLogRow | null> {
  const result = await pool.query(
    `SELECT * FROM activity_logs WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return mapActivityLogRow(result.rows[0]);
}

/**
 * Get recent activity logs, optionally filtered by tool name.
 */
export async function getRecentActivityLogs(
  pool: pg.Pool,
  params: {
    chatId?: string;
    toolName?: string;
    since?: Date;
    limit: number;
  }
): Promise<ActivityLogRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.chatId) {
    values.push(params.chatId);
    conditions.push(`chat_id = $${values.length}`);
  }
  if (params.since) {
    values.push(params.since);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (params.toolName) {
    values.push(params.toolName);
    conditions.push(`tool_calls @> jsonb_build_array(jsonb_build_object('name', $${values.length}::text))`);
  }

  values.push(params.limit);
  const whereClause =
    conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const result = await pool.query(
    `SELECT * FROM activity_logs ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return result.rows.map(mapActivityLogRow);
}

// ============================================================================
// Helpers
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

function mapPatternRow(row: Record<string, unknown>): PatternRow {
  return {
    id: row.id as number,
    content: row.content as string,
    kind: row.kind as string,
    confidence: parseFloat(row.confidence as string),
    strength: parseFloat(row.strength as string),
    times_seen: row.times_seen as number,
    status: row.status as string,
    temporal: row.temporal as Record<string, unknown> | null,
    canonical_hash: row.canonical_hash as string | null,
    source_type: (row.source_type as string) ?? "compaction",
    source_id: (row.source_id as string | null) ?? null,
    expires_at: (row.expires_at as Date | null) ?? null,
    first_seen: row.first_seen as Date,
    last_seen: row.last_seen as Date,
    created_at: row.created_at as Date,
  };
}

function mapSoulStateRow(row: Record<string, unknown>): ChatSoulStateRow {
  return {
    chat_id: String(row.chat_id),
    identity_summary: row.identity_summary as string,
    relational_commitments:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */ (row
        .relational_commitments as string[]) || [],
    tone_signature:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */ (row
        .tone_signature as string[]) || [],
    growth_notes:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */ (row
        .growth_notes as string[]) || [],
    version: Number(row.version),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function mapSoulQualitySignalRow(row: Record<string, unknown>): SoulQualitySignalRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    assistant_message_id: (row.assistant_message_id as number | null) ?? null,
    signal_type: row.signal_type as string,
    soul_version: Number(row.soul_version),
    pattern_count: Number(row.pattern_count),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at as Date,
  };
}

function mapPulseCheckRow(row: Record<string, unknown>): PulseCheckRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    status: row.status as string,
    personal_ratio: parseFloat(row.personal_ratio as string),
    correction_rate: parseFloat(row.correction_rate as string),
    signal_counts: (row.signal_counts as Record<string, number>) ?? {},
    repairs_applied: (row.repairs_applied as Record<string, unknown>[]) ?? [],
    soul_version_before: Number(row.soul_version_before),
    soul_version_after: Number(row.soul_version_after),
    created_at: row.created_at as Date,
  };
}

function mapSoulStateHistoryRow(row: Record<string, unknown>): SoulStateHistoryRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    version: Number(row.version),
    identity_summary: row.identity_summary as string,
    relational_commitments:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.relational_commitments as string[]) || [],
    tone_signature:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.tone_signature as string[]) || [],
    growth_notes:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.growth_notes as string[]) || [],
    change_reason: row.change_reason as string,
    created_at: row.created_at as Date,
  };
}

function mapActivityLogRow(row: Record<string, unknown>): ActivityLogRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    memories: (row.memories as ActivityLogMemory[]) ?? [] /* v8 ignore next -- defensive: SQL defaults to '[]' */,
    tool_calls: (row.tool_calls as ActivityLogToolCall[]) ?? [] /* v8 ignore next -- defensive: SQL defaults to '[]' */,
    cost_usd: row.cost_usd != null ? parseFloat(row.cost_usd as string) : null,
    created_at: row.created_at as Date,
  };
}

function mapEntryRow(row: Record<string, unknown>): EntryRow {
  return {
    id: row.id as number,
    uuid: row.uuid as string,
    text: row.text as string,
    created_at: row.created_at as Date,
    modified_at: row.modified_at as Date | null,
    timezone: row.timezone as string | null,
    city: row.city as string | null,
    country: row.country as string | null,
    place_name: row.place_name as string | null,
    admin_area: row.admin_area as string | null,
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    temperature: row.temperature as number | null,
    weather_conditions: row.weather_conditions as string | null,
    humidity: row.humidity as number | null,
    tags: (row.tags as string[]) || [] /* v8 ignore next -- defensive: SQL coalesces to '{}' */,
    photo_count: row.photo_count as number,
    video_count: row.video_count as number,
    audio_count: row.audio_count as number,
    media: (row.media as MediaItem[]) || [],
    weight_kg: row.weight_kg != null ? parseFloat(row.weight_kg as string) : null,
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
