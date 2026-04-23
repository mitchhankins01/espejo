import type pg from "pg";

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
