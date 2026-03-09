import type pg from "pg";

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
  minSimilarity: number = 0.35
): Promise<PatternSearchRow[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const result = await pool.query(
    `WITH scored AS (
      SELECT *,
        1 - (embedding <=> $1::vector) AS sim,
        CASE kind
          WHEN 'identity' THEN 3650
          WHEN 'preference' THEN 180
          WHEN 'goal' THEN 90
          ELSE 180
        END AS half_life,
        CASE kind
          WHEN 'identity' THEN 0.85
          WHEN 'preference' THEN 0.40
          WHEN 'goal' THEN 0.30
          ELSE 0.40
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

/* v8 ignore start -- memory-v2 hybrid/maintenance query paths are validated by higher-level tool tests */
/**
 * Text search patterns via tsvector.
 * Returns scored rows compatible with semantic retrieval rows.
 */
export async function textSearchPatterns(
  pool: pg.Pool,
  queryText: string,
  limit: number
): Promise<PatternSearchRow[]> {
  const result = await pool.query(
    `SELECT
       *,
       ts_rank(text_search, websearch_to_tsquery('english', $1)) AS rank_score
     FROM patterns
     WHERE status IN ('active', 'disputed')
       AND (expires_at IS NULL OR expires_at > NOW())
       AND text_search @@ websearch_to_tsquery('english', $1)
     ORDER BY rank_score DESC
     LIMIT $2`,
    [queryText, limit]
  );

  return result.rows.map((row) => ({
    ...mapPatternRow(row),
    score: parseFloat(row.rank_score as string),
    similarity: 0,
  }));
}

export async function searchPatternsHybrid(
  pool: pg.Pool,
  queryEmbedding: number[],
  queryText: string,
  limit: number,
  minSimilarity: number = 0.35
): Promise<PatternSearchRow[]> {
  const [semantic, textual] = await Promise.all([
    searchPatterns(pool, queryEmbedding, Math.max(limit, 15), minSimilarity),
    textSearchPatterns(pool, queryText, 10),
  ]);

  const sourceRanks = new Map<number, { semanticRank?: number; textRank?: number; row: PatternSearchRow }>();

  semantic.forEach((row, idx) => {
    sourceRanks.set(row.id, { semanticRank: idx + 1, row });
  });

  textual.forEach((row, idx) => {
    const existing = sourceRanks.get(row.id);
    if (existing) {
      existing.textRank = idx + 1;
      if (row.score > existing.row.score) {
        existing.row = { ...existing.row, ...row };
      }
      return;
    }
    sourceRanks.set(row.id, { textRank: idx + 1, row });
  });

  const merged = [...sourceRanks.values()]
    .map((entry) => {
      const score =
        (entry.semanticRank ? 1 / (60 + entry.semanticRank) : 0) +
        (entry.textRank ? 1 / (60 + entry.textRank) : 0);
      return {
        ...entry.row,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return merged;
}

/**
 * Get active preference/identity patterns describing language preferences.
 * These are used as always-on communication anchors in chat prompts.
 */
export async function getLanguagePreferencePatterns(
  pool: pg.Pool,
  limit: number
): Promise<PatternRow[]> {
  const result = await pool.query(
    `SELECT * FROM patterns
     WHERE status = 'active'
       AND kind IN ('preference', 'identity')
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

export interface PatternStatsSummary {
  by_kind: Record<string, number>;
  by_status: Record<string, number>;
  active_total: number;
  avg_confidence: number;
}

export async function getPatternStats(
  pool: pg.Pool,
  kind?: string
): Promise<PatternStatsSummary> {
  const kindFilter = kind ? "AND kind = $1" : "";
  const values = kind ? [kind] : [];

  const [kindCounts, statusCounts, activeSummary] = await Promise.all([
    pool.query(
      `SELECT kind, COUNT(*)::int AS count
       FROM patterns
       WHERE 1=1 ${kindFilter}
       GROUP BY kind`,
      values
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM patterns
       WHERE 1=1 ${kindFilter}
       GROUP BY status`,
      values
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS active_total,
         COALESCE(AVG(confidence), 0)::float AS avg_confidence
       FROM patterns
       WHERE status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         ${kindFilter}`,
      values
    ),
  ]);

  const byKind: Record<string, number> = {};
  for (const row of kindCounts.rows) {
    byKind[String(row.kind)] = Number(row.count);
  }
  const byStatus: Record<string, number> = {};
  for (const row of statusCounts.rows) {
    byStatus[String(row.status)] = Number(row.count);
  }

  return {
    by_kind: byKind,
    by_status: byStatus,
    active_total: Number(activeSummary.rows[0]?.active_total ?? 0),
    avg_confidence: Number(activeSummary.rows[0]?.avg_confidence ?? 0),
  };
}

export async function getStalePatterns(
  pool: pg.Pool,
  staleDays: number,
  kind?: string,
  limit: number = 20
): Promise<PatternRow[]> {
  const values: unknown[] = [staleDays, limit];
  let kindClause = "";
  if (kind) {
    values.push(kind);
    kindClause = `AND kind = $3`;
  }
  const result = await pool.query(
    `SELECT *
     FROM patterns
     WHERE status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
       AND last_seen < NOW() - ($1::text || ' days')::interval
       ${kindClause}
     ORDER BY last_seen ASC
     LIMIT $2`,
    values
  );
  return result.rows.map(mapPatternRow);
}

export interface PatternSimilarityPair {
  kind: string;
  pattern_id_1: number;
  pattern_id_2: number;
  content_1: string;
  content_2: string;
  similarity: number;
}

export async function findSimilarPatternPairs(
  pool: pg.Pool,
  minSimilarity: number,
  kind?: string,
  limit: number = 20
): Promise<PatternSimilarityPair[]> {
  const values: unknown[] = [minSimilarity, limit];
  let kindClause = "";
  if (kind) {
    values.push(kind);
    kindClause = "AND p1.kind = $3 AND p2.kind = $3";
  }

  const result = await pool.query(
    `SELECT
       p1.kind,
       p1.id AS pattern_id_1,
       p2.id AS pattern_id_2,
       p1.content AS content_1,
       p2.content AS content_2,
       1 - (p1.embedding <=> p2.embedding) AS similarity
     FROM patterns p1
     JOIN patterns p2
       ON p1.id < p2.id
      AND p1.kind = p2.kind
     WHERE p1.status = 'active'
       AND p2.status = 'active'
       AND p1.embedding IS NOT NULL
       AND p2.embedding IS NOT NULL
       AND (p1.expires_at IS NULL OR p1.expires_at > NOW())
       AND (p2.expires_at IS NULL OR p2.expires_at > NOW())
       AND 1 - (p1.embedding <=> p2.embedding) >= $1
       ${kindClause}
     ORDER BY similarity DESC
     LIMIT $2`,
    values
  );

  return result.rows.map((row) => ({
    kind: row.kind as string,
    pattern_id_1: Number(row.pattern_id_1),
    pattern_id_2: Number(row.pattern_id_2),
    content_1: row.content_1 as string,
    content_2: row.content_2 as string,
    similarity: parseFloat(row.similarity as string),
  }));
}

export async function enforceActivePatternCap(
  pool: pg.Pool,
  maxActive: number
): Promise<number> {
  const result = await pool.query(
    `WITH ranked AS (
       SELECT
         id,
         ROW_NUMBER() OVER (
           ORDER BY
             (confidence * LN(1 + LEAST(strength, 20)) * LN(1 + LEAST(times_seen, 50))) DESC,
             last_seen DESC
         ) AS rn
       FROM patterns
       WHERE status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
     )
     UPDATE patterns p
     SET status = 'deprecated'
     FROM ranked r
     WHERE p.id = r.id
       AND r.rn > $1`,
    [maxActive]
  );
  return result.rowCount ?? 0;
}
/* v8 ignore stop */

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
