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
    `SELECT * FROM chat_messages
     WHERE chat_id = $1 AND compacted_at IS NULL
     ORDER BY created_at ASC
     LIMIT $2`,
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
    timestamp: Date;
  }
): Promise<PatternRow> {
  const embeddingStr = params.embedding
    ? `[${params.embedding.join(",")}]`
    : null;
  const result = await pool.query(
    `INSERT INTO patterns (content, kind, confidence, embedding, temporal, canonical_hash, first_seen, last_seen)
     VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $7)
     RETURNING *`,
    [
      params.content,
      params.kind,
      params.confidence,
      embeddingStr,
      params.temporal ? JSON.stringify(params.temporal) : null,
      params.canonicalHash,
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
          WHEN 'temporal' THEN 365 WHEN 'causal' THEN 90 ELSE 90
        END AS half_life,
        CASE kind
          WHEN 'behavior' THEN 0.45 WHEN 'belief' THEN 0.45 WHEN 'goal' THEN 0.35
          WHEN 'preference' THEN 0.45 WHEN 'emotion' THEN 0.15
          WHEN 'temporal' THEN 0.60 WHEN 'causal' THEN 0.45 ELSE 0.45
        END AS floor_val,
        CASE status
          WHEN 'active' THEN 1.0 WHEN 'disputed' THEN 0.5 ELSE 0.0
        END AS validity
      FROM patterns
      WHERE embedding IS NOT NULL AND status IN ('active', 'disputed')
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
 * Get top patterns by strength (for compaction context, no embedding needed).
 */
export async function getTopPatterns(
  pool: pg.Pool,
  limit: number
): Promise<PatternRow[]> {
  const result = await pool.query(
    `SELECT * FROM patterns
     WHERE status = 'active'
     ORDER BY strength DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapPatternRow);
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
  }
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO pattern_observations (pattern_id, chat_message_ids, evidence, evidence_roles, confidence)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      params.patternId,
      params.chatMessageIds,
      params.evidence,
      params.evidenceRoles,
      params.confidence,
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

// ============================================================================
// Helpers
// ============================================================================

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
    first_seen: row.first_seen as Date,
    last_seen: row.last_seen as Date,
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
