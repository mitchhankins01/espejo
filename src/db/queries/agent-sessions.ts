import type pg from "pg";

export type SessionSurface = "claude-code" | "opencode" | "codex";

export interface AgentSessionRow {
  surface: SessionSurface;
  session_id: string;
  project_path: string;
  started_at: Date;
  ended_at: Date | null;
  message_count: number;
  user_msg_count: number;
  tool_call_count: number;
  tools_used: string[];
  tool_calls: unknown[]; // [{name, args, ok, ts, error?, truncated?}]
  prompts: unknown[]; // [{ts, text}]
  models: string[];
  transcript_uri: string | null;
  source_mtime: Date | null;
}

/**
 * Idempotent upsert. The unique key is (surface, session_id) so re-running
 * the ingestor on a session that has grown updates the row in place.
 * `ingested_at` is bumped on every upsert so callers can tell when a row was
 * last touched.
 */
export async function upsertSession(
  pool: pg.Pool,
  row: AgentSessionRow
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_sessions
       (surface, session_id, project_path, started_at, ended_at,
        message_count, user_msg_count, tool_call_count,
        tools_used, tool_calls, prompts, models,
        transcript_uri, source_mtime, ingested_at)
     VALUES
       ($1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10::jsonb, $11::jsonb, $12,
        $13, $14, NOW())
     ON CONFLICT (surface, session_id) DO UPDATE SET
       project_path    = EXCLUDED.project_path,
       started_at      = EXCLUDED.started_at,
       ended_at        = EXCLUDED.ended_at,
       message_count   = EXCLUDED.message_count,
       user_msg_count  = EXCLUDED.user_msg_count,
       tool_call_count = EXCLUDED.tool_call_count,
       tools_used      = EXCLUDED.tools_used,
       tool_calls      = EXCLUDED.tool_calls,
       prompts         = EXCLUDED.prompts,
       models          = EXCLUDED.models,
       transcript_uri  = EXCLUDED.transcript_uri,
       source_mtime    = EXCLUDED.source_mtime,
       ingested_at     = NOW()`,
    [
      row.surface,
      row.session_id,
      row.project_path,
      row.started_at,
      row.ended_at,
      row.message_count,
      row.user_msg_count,
      row.tool_call_count,
      row.tools_used,
      JSON.stringify(row.tool_calls),
      JSON.stringify(row.prompts),
      row.models,
      row.transcript_uri,
      row.source_mtime,
    ]
  );
}

/**
 * Watermark: most recent source_mtime we've ingested for a given surface.
 * Returns null if the table is empty for that surface.
 */
export async function latestSourceMtime(
  pool: pg.Pool,
  surface: SessionSurface
): Promise<Date | null> {
  const r = await pool.query<{ mtime: Date | null }>(
    `SELECT MAX(source_mtime) AS mtime FROM agent_sessions WHERE surface = $1`,
    [surface]
  );
  return r.rows[0]?.mtime ?? null;
}

/**
 * Most recent successful ingest run timestamp across all surfaces.
 * Drives the --skip-if-fresh check.
 */
export async function latestIngestedAt(
  pool: pg.Pool
): Promise<Date | null> {
  const r = await pool.query<{ ingested_at: Date | null }>(
    `SELECT MAX(ingested_at) AS ingested_at FROM agent_sessions`
  );
  return r.rows[0]?.ingested_at ?? null;
}
