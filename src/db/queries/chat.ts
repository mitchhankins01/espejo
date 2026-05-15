import type pg from "pg";

export interface ChatMessageRow {
  id: number;
  chat_id: string;
  external_message_id: string | null;
  role: string;
  content: string;
  tool_call_id: string | null;
  compacted_at: Date | null;
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
 * Get recent uncompacted messages, ordered oldest first.
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
         WHERE chat_id = $1 AND compacted_at IS NULL AND (flow IS NULL OR flow = $3)
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
 * User-turn prompts from Telegram chat_messages within a timestamp range,
 * filtered to the conversational flows that signal *what Mitch reached for*
 * (chat thinking-out-loud, vault-prompt invocations, practice sessions, HN
 * distillation). Excludes utility flows like checkpoint/weight/srs.
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
       AND flow IN ('chat', 'vault-prompt', 'practice', 'distill-hn')
     ORDER BY created_at ASC, id ASC`,
    [options.fromDate, options.toDate, options.timezone]
  );
  return result.rows;
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
