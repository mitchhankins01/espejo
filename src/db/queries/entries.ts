import crypto from "crypto";
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
  source: "dayone" | "web" | "telegram" | "mcp";
  version: number;
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
  city?: string;
}

// ============================================================================
// Private helpers
// ============================================================================

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
    /* v8 ignore next 2 -- defensive: DB defaults always provide these */
    source: (row.source as EntryRow["source"]) ?? "dayone",
    version: (row.version as number) ?? 1,
    photo_count: row.photo_count as number,
    video_count: row.video_count as number,
    audio_count: row.audio_count as number,
    media: (row.media as MediaItem[]) || [],
    weight_kg: row.weight_kg != null ? parseFloat(row.weight_kg as string) : null,
  };
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
 * Get a single entry by UUID with full metadata and media counts.
 */
export async function getEntryByUuid(
  pool: pg.Pool,
  uuid: string
): Promise<EntryRow | null> {
  const result = await pool.query(
    `SELECT
      e.*,
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
    /* v8 ignore next 2 -- defensive: DB defaults always provide these */
    source: row.source ?? "dayone",
    version: row.version ?? 1,
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
 * Search entries for source picker (lightweight text search).
 */
export async function searchEntriesForPicker(
  pool: pg.Pool,
  queryText: string,
  limit: number
): Promise<Array<{ uuid: string; created_at: Date; preview: string }>> {
  const result = await pool.query(
    `SELECT uuid, created_at, LEFT(COALESCE(text, ''), 120) AS preview
     FROM entries
     WHERE text_search @@ plainto_tsquery('english', $1)
     ORDER BY ts_rank(text_search, plainto_tsquery('english', $1)) DESC
     LIMIT $2`,
    [queryText, limit]
  );

  return result.rows.map((row) => ({
    uuid: row.uuid as string,
    created_at: row.created_at as Date,
    preview: row.preview as string,
  }));
}

// ============================================================================
// Web journaling: Entry CRUD
// ============================================================================

const ENTRY_SELECT = `
  e.*,
  (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'photo') AS photo_count,
  (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'video') AS video_count,
  (SELECT COUNT(*)::int FROM media m WHERE m.entry_id = e.id AND m.type = 'audio') AS audio_count,
  (SELECT COALESCE(json_agg(json_build_object(
    'id', m.id, 'type', m.type, 'url', m.url, 'storage_key', m.storage_key, 'dimensions', m.dimensions
  ) ORDER BY m.id) FILTER (WHERE m.url IS NOT NULL), '[]'::json)
  FROM media m WHERE m.entry_id = e.id) AS media,
  dm.weight_kg
`;

export type EntrySource = "dayone" | "web" | "telegram" | "mcp";

export interface CreateEntryData {
  text: string;
  timezone?: string;
  created_at?: string;
  city?: string;
  country?: string;
  place_name?: string;
  latitude?: number;
  longitude?: number;
  source?: EntrySource;
}

export async function createEntry(
  pool: pg.Pool,
  data: CreateEntryData
): Promise<EntryRow> {
  const uuid = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO entries (uuid, text, timezone, created_at, city, country, place_name, latitude, longitude, source, version)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), $5, $6, $7, $8, $9, $10, 1)`,
      [
        uuid,
        data.text,
        data.timezone ?? null,
        data.created_at ?? null,
        data.city ?? null,
        data.country ?? null,
        data.place_name ?? null,
        data.latitude ?? null,
        data.longitude ?? null,
        data.source ?? "web",
      ]
    );

    await client.query("COMMIT");

    // Fetch full row with aggregates
    const full = await pool.query(
      `SELECT ${ENTRY_SELECT} FROM entries e LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date WHERE e.uuid = $1`,
      [uuid]
    );
    return mapEntryRow(full.rows[0] as Record<string, unknown>);
  /* v8 ignore next 4 */
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface UpdateEntryData {
  text?: string;
  timezone?: string;
  created_at?: string;
  city?: string;
  country?: string;
  place_name?: string;
  latitude?: number;
  longitude?: number;
}

export async function updateEntry(
  pool: pg.Pool,
  uuid: string,
  expectedVersion: number,
  data: UpdateEntryData
): Promise<EntryRow | "version_conflict" | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Optimistic lock: atomically bump version only if it matches
    const setClauses: string[] = [];
    const params: unknown[] = [uuid, expectedVersion];
    let paramIdx = 2;

    // Always bump version and modified_at for web edits
    setClauses.push("version = version + 1");
    setClauses.push("modified_at = NOW()");

    if (data.text !== undefined) {
      paramIdx++;
      setClauses.push(`text = $${paramIdx}`);
      params.push(data.text);
      // Invalidate embedding when text changes
      setClauses.push("embedding = NULL");
    }
    if (data.timezone !== undefined) {
      paramIdx++;
      setClauses.push(`timezone = $${paramIdx}`);
      params.push(data.timezone);
    }
    if (data.created_at !== undefined) {
      paramIdx++;
      setClauses.push(`created_at = $${paramIdx}::timestamptz`);
      params.push(data.created_at);
    }
    if (data.city !== undefined) {
      paramIdx++;
      setClauses.push(`city = $${paramIdx}`);
      params.push(data.city);
    }
    if (data.country !== undefined) {
      paramIdx++;
      setClauses.push(`country = $${paramIdx}`);
      params.push(data.country);
    }
    if (data.place_name !== undefined) {
      paramIdx++;
      setClauses.push(`place_name = $${paramIdx}`);
      params.push(data.place_name);
    }
    if (data.latitude !== undefined) {
      paramIdx++;
      setClauses.push(`latitude = $${paramIdx}`);
      params.push(data.latitude);
    }
    if (data.longitude !== undefined) {
      paramIdx++;
      setClauses.push(`longitude = $${paramIdx}`);
      params.push(data.longitude);
    }

    const result = await client.query(
      `UPDATE entries
       SET ${setClauses.join(", ")}
       WHERE uuid = $1 AND version = $2
       RETURNING id`,
      params
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      // Check if entry exists at all
      const exists = await pool.query(
        `SELECT uuid FROM entries WHERE uuid = $1`,
        [uuid]
      );
      return exists.rows.length === 0 ? null : "version_conflict";
    }

    await client.query("COMMIT");

    // Fetch full row
    const full = await pool.query(
      `SELECT ${ENTRY_SELECT} FROM entries e LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date WHERE e.uuid = $1`,
      [uuid]
    );
    return mapEntryRow(full.rows[0] as Record<string, unknown>);
  /* v8 ignore next 4 */
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteEntry(
  pool: pg.Pool,
  uuid: string
): Promise<boolean> {
  const result = await pool.query(`DELETE FROM entries WHERE uuid = $1`, [uuid]);
  /* v8 ignore next */
  return (result.rowCount ?? 0) > 0;
}

export interface ListEntriesFilters {
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
  source?: string;
  q?: string;
}

export async function listEntries(
  pool: pg.Pool,
  filters: ListEntriesFilters
): Promise<{ rows: EntryRow[]; count: number }> {
  const whereClauses: string[] = [];
  const whereParams: unknown[] = [];
  let paramIdx = 0;

  if (filters.from) {
    paramIdx++;
    whereClauses.push(`e.created_at >= $${paramIdx}::timestamptz`);
    whereParams.push(filters.from);
  }
  if (filters.to) {
    paramIdx++;
    whereClauses.push(`e.created_at < ($${paramIdx}::date + interval '1 day')`);
    whereParams.push(filters.to);
  }
  if (filters.source) {
    paramIdx++;
    whereClauses.push(`e.source = $${paramIdx}`);
    whereParams.push(filters.source);
  }
  if (filters.q) {
    paramIdx++;
    whereClauses.push(`e.text_search @@ plainto_tsquery('english', $${paramIdx})`);
    whereParams.push(filters.q);
  }

  const whereClause =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;

  paramIdx++;
  const limitParam = paramIdx;
  paramIdx++;
  const offsetParam = paramIdx;

  const params = [...whereParams, limit, offset];

  const [rowsResult, countResult] = await Promise.all([
    pool.query(
      `SELECT ${ENTRY_SELECT}
       FROM entries e
       LEFT JOIN daily_metrics dm ON dm.date = e.created_at::date
       ${whereClause}
       ORDER BY e.created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params
    ),
    pool.query(
      `SELECT count(*)::int AS total FROM entries e ${whereClause}`,
      whereParams
    ),
  ]);

  return {
    rows: rowsResult.rows.map((row) =>
      mapEntryRow(row as Record<string, unknown>)
    ),
    count: countResult.rows[0].total as number,
  };
}

