import type pg from "pg";

// ============================================================================
// Activity logs
// ============================================================================

export interface ActivityLogRow {
  id: number;
  chat_id: string;
  memories: unknown[];
  tool_calls: ActivityLogToolCall[];
  cost_usd: number | null;
  created_at: Date;
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
    memories: unknown[];
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

function mapActivityLogRow(row: Record<string, unknown>): ActivityLogRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    memories: (row.memories as unknown[]) ?? [] /* v8 ignore next -- defensive: SQL defaults to '[]' */,
    tool_calls: (row.tool_calls as ActivityLogToolCall[]) ?? [] /* v8 ignore next -- defensive: SQL defaults to '[]' */,
    cost_usd: row.cost_usd != null ? parseFloat(row.cost_usd as string) : null,
    created_at: row.created_at as Date,
  };
}
