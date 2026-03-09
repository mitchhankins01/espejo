import type pg from "pg";

export type InsightType = "temporal_echo" | "biometric_correlation" | "stale_todo" | "oura_notable";

export interface InsightRow {
  id: number;
  type: InsightType;
  content_hash: string;
  title: string;
  body: string;
  relevance: number;
  metadata: Record<string, unknown>;
  notified_at: Date | null;
  dismissed: boolean;
  created_at: Date;
}

export async function insertInsight(
  pool: pg.Pool,
  type: InsightType,
  contentHash: string,
  title: string,
  body: string,
  relevance: number,
  metadata: Record<string, unknown>
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO insights (type, content_hash, title, body, relevance, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [type, contentHash, title, body, relevance, JSON.stringify(metadata)]
  );
  return result.rows[0].id;
}

export async function insightHashExists(
  pool: pg.Pool,
  contentHash: string,
  windowDays: number
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM insights
       WHERE content_hash = $1
         AND created_at > NOW() - MAKE_INTERVAL(days => $2)
     ) AS exists`,
    [contentHash, windowDays]
  );
  return result.rows[0].exists;
}

export async function countInsightsNotifiedToday(
  pool: pg.Pool,
  timezone: string
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM insights
     WHERE notified_at IS NOT NULL
       AND (notified_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date`,
    [timezone]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function markInsightNotified(
  pool: pg.Pool,
  id: number
): Promise<void> {
  await pool.query(
    `UPDATE insights SET notified_at = NOW() WHERE id = $1`,
    [id]
  );
}

export interface TemporalEchoRow {
  current_uuid: string;
  echo_uuid: string;
  echo_year: number;
  similarity: number;
  echo_preview: string;
  current_preview: string;
}

export async function findTemporalEchoes(
  pool: pg.Pool,
  month: number,
  day: number,
  currentYear: number,
  threshold: number,
  timezone: string,
  limit: number
): Promise<TemporalEchoRow[]> {
  const result = await pool.query<TemporalEchoRow>(
    `WITH current_entries AS (
        SELECT id, uuid, embedding, LEFT(text, 200) AS preview
        FROM entries
        WHERE EXTRACT(MONTH FROM created_at AT TIME ZONE $6) = $1
          AND EXTRACT(DAY FROM created_at AT TIME ZONE $6) = $2
          AND EXTRACT(YEAR FROM created_at AT TIME ZONE $6) = $3
          AND embedding IS NOT NULL
     ),
     past_entries AS (
        SELECT id, uuid, embedding, LEFT(text, 200) AS preview,
               EXTRACT(YEAR FROM created_at AT TIME ZONE $6)::int AS echo_year
        FROM entries
        WHERE EXTRACT(MONTH FROM created_at AT TIME ZONE $6) = $1
          AND EXTRACT(DAY FROM created_at AT TIME ZONE $6) = $2
          AND EXTRACT(YEAR FROM created_at AT TIME ZONE $6) != $3
          AND embedding IS NOT NULL
     )
     SELECT c.uuid AS current_uuid, p.uuid AS echo_uuid, p.echo_year,
            1 - (c.embedding <=> p.embedding) AS similarity,
            p.preview AS echo_preview, c.preview AS current_preview
     FROM current_entries c
     CROSS JOIN past_entries p
     WHERE 1 - (c.embedding <=> p.embedding) > $4
     ORDER BY similarity DESC
     LIMIT $5`,
    [month, day, currentYear, threshold, limit, timezone]
  );
  return result.rows;
}

export interface StaleTodoRow {
  id: string;
  title: string;
  days_stale: number;
  important: boolean;
  urgent: boolean;
  next_step: string | null;
}

export async function findStaleTodos(
  pool: pg.Pool,
  staleDays: number,
  limit: number
): Promise<StaleTodoRow[]> {
  const result = await pool.query<StaleTodoRow>(
    `SELECT id, title,
            FLOOR(EXTRACT(EPOCH FROM NOW() - updated_at) / 86400)::int AS days_stale,
            important, urgent, next_step
     FROM todos
     WHERE status = 'active'
       AND updated_at < NOW() - MAKE_INTERVAL(days => $1)
     ORDER BY important DESC, FLOOR(EXTRACT(EPOCH FROM NOW() - updated_at) / 86400) DESC
     LIMIT $2`,
    [staleDays, limit]
  );
  return result.rows;
}
