import type pg from "pg";

export interface ChatMessageRow {
  id: number;
  chat_id: string;
  external_message_id: string | null;
  role: string;
  content: string;
  tool_call_id: string | null;
  flow: string | null;
  created_at: Date;
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
    flow?: string | null;
  }
): Promise<{ inserted: boolean; id: number | null }> {
  const result = await pool.query(
    `INSERT INTO chat_messages (chat_id, external_message_id, role, content, tool_call_id, flow)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (external_message_id) DO NOTHING
     RETURNING id`,
    [
      params.chatId,
      params.externalMessageId,
      params.role,
      params.content,
      params.toolCallId ?? null,
      params.flow ?? null,
    ]
  );
  return {
    inserted: result.rowCount !== null && result.rowCount > 0,
    id: result.rows[0]?.id ?? null,
  };
}

/**
 * Get user + assistant messages for a chat since a timestamp, oldest first.
 * Used for practice session extraction — excludes tool_result rows.
 */
export async function getMessagesSince(
  pool: pg.Pool,
  chatId: string,
  since: Date
): Promise<ChatMessageRow[]> {
  const result = await pool.query(
    `SELECT *
     FROM chat_messages
     WHERE chat_id = $1
       AND created_at >= $2
       AND role IN ('user', 'assistant')
     ORDER BY created_at ASC, id ASC`,
    [chatId, since]
  );
  return result.rows;
}

/**
 * Get recent messages, ordered oldest first.
 * If `flow` is provided, returns rows where `flow IS NULL OR flow = $flow`
 * (NULL covers historical rows pre-`flow` migration).
 */
export async function getRecentMessages(
  pool: pg.Pool,
  chatId: string,
  limit: number,
  flow?: string
): Promise<ChatMessageRow[]> {
  if (flow !== undefined) {
    const result = await pool.query(
      `SELECT *
       FROM (
         SELECT *
         FROM chat_messages
         WHERE chat_id = $1 AND (flow IS NULL OR flow = $3)
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) AS recent
       ORDER BY created_at ASC, id ASC`,
      [chatId, limit, flow]
    );
    return result.rows;
  }
  const result = await pool.query(
    `SELECT *
     FROM (
       SELECT *
       FROM chat_messages
       WHERE chat_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     ) AS recent
     ORDER BY created_at ASC, id ASC`,
    [chatId, limit]
  );
  return result.rows;
}

/**
 * Messages in the current chat session: user/assistant turns newer than the
 * most recent session-boundary marker (see resetChatSession), newest first,
 * bounded by maxRows. The caller trims to a token budget and reverses to
 * oldest-first. tool_result rows are excluded — they're never replayed to the
 * model.
 */
export async function getSessionMessages(
  pool: pg.Pool,
  chatId: string,
  flow: string,
  maxRows: number
): Promise<ChatMessageRow[]> {
  const result = await pool.query(
    `SELECT *
     FROM chat_messages
     WHERE chat_id = $1
       AND (flow IS NULL OR flow = $2)
       AND role IN ('user', 'assistant')
       AND id > COALESCE(
         (SELECT MAX(id) FROM chat_messages
          WHERE chat_id = $1 AND role = 'reset' AND (flow IS NULL OR flow = $2)),
         0)
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [chatId, flow, maxRows]
  );
  return result.rows;
}

/**
 * End the current chat session by writing a boundary marker row. The next
 * getSessionMessages load starts after it, so context resets to empty without
 * deleting anything — analytics (getRecentChatPrompts) still read every row.
 * Returns the count of user/assistant messages that were in the closed session
 * (0 means there was nothing to clear).
 */
export async function resetChatSession(
  pool: pg.Pool,
  chatId: string,
  flow: string
): Promise<number> {
  const countResult = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
     FROM chat_messages
     WHERE chat_id = $1
       AND (flow IS NULL OR flow = $2)
       AND role IN ('user', 'assistant')
       AND id > COALESCE(
         (SELECT MAX(id) FROM chat_messages
          WHERE chat_id = $1 AND role = 'reset' AND (flow IS NULL OR flow = $2)),
         0)`,
    [chatId, flow]
  );
  await pool.query(
    `INSERT INTO chat_messages (chat_id, external_message_id, role, content, flow)
     VALUES ($1, NULL, 'reset', '', $2)`,
    [chatId, flow]
  );
  return Number(countResult.rows[0]?.n ?? 0);
}

/**
 * User-turn prompts from Telegram chat_messages within a timestamp range.
 * Returns every user-side interaction with the bot regardless of flow —
 * chat (thinking out loud), vault-prompt (which prompts ran), practice/srs
 * (Spanish engagement), distill-hn (reading), checkpoint (tolls), weight
 * (body logs), plus untagged flows. Cluster shape and timing carry the
 * signal across flow types; richer per-flow data lives in dedicated tools
 * (get_recent_checkpoints, get_recent_weights) but this query is the
 * complete Telegram interaction timeline.
 */
export interface RecentChatPromptRow {
  created_at: Date;
  flow: string | null;
  content: string;
}

export async function getRecentChatPrompts(
  pool: pg.Pool,
  options: { fromDate: string; toDate: string; timezone: string }
): Promise<RecentChatPromptRow[]> {
  const result = await pool.query<RecentChatPromptRow>(
    `SELECT created_at, flow, content
     FROM chat_messages
     WHERE (created_at AT TIME ZONE $3)::date >= $1::date
       AND (created_at AT TIME ZONE $3)::date <= $2::date
       AND role = 'user'
     ORDER BY created_at ASC, id ASC`,
    [options.fromDate, options.toDate, options.timezone]
  );
  return result.rows;
}
