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

export interface SoulStateRow {
  id: number;
  identity_summary: string;
  relational_commitments: string[];
  tone_signature: string[];
  growth_notes: string[];
  version: number;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

// Back-compat alias used in existing call sites/tests.
export type ChatSoulStateRow = SoulStateRow;

function mapSoulStateRow(row: Record<string, unknown>): ChatSoulStateRow {
  return {
    id: Number(row.id),
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
    /* v8 ignore next -- defensive: historical rows may not have updated_by populated */
    updated_by: String((row.updated_by as string | null) ?? "system"),
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
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
 * Get the persistent global soul state singleton.
 */
export async function getSoulState(
  pool: pg.Pool,
  _chatId?: string
): Promise<ChatSoulStateRow | null> {
  const result = await pool.query(
    `SELECT *
     FROM soul_state
     WHERE id = 1
     LIMIT 1`,
    []
  );
  if (result.rows.length === 0) return null;
  return mapSoulStateRow(result.rows[0]);
}

/**
 * Insert or update the global soul state.
 * When `version` is provided, performs optimistic locking against current version.
 */
export async function upsertSoulState(
  pool: pg.Pool,
  params: {
    chatId?: string;
    identitySummary: string;
    relationalCommitments: string[];
    toneSignature: string[];
    growthNotes: string[];
    version?: number;
  }
): Promise<ChatSoulStateRow> {
  /* v8 ignore next -- default updatedBy path used only for non-chat callers */
  const updatedBy = params.chatId ?? "system";

  if (params.version != null) {
    const expectedVersion = Math.max(1, params.version);
    const updateResult = await pool.query(
      `UPDATE soul_state
       SET
         identity_summary = $1,
         relational_commitments = $2,
         tone_signature = $3,
         growth_notes = $4,
         version = soul_state.version + 1,
         updated_by = $5,
         updated_at = NOW()
       WHERE id = 1 AND version = $6
       RETURNING *`,
      [
        params.identitySummary,
        params.relationalCommitments,
        params.toneSignature,
        params.growthNotes,
        updatedBy,
        expectedVersion,
      ]
    );
    if (updateResult.rows.length === 0) {
      throw new Error(
        "Soul state version conflict. Reload soul state and retry with the latest version."
      );
    }
    return mapSoulStateRow(updateResult.rows[0]);
  }

  const result = await pool.query(
    `INSERT INTO soul_state (
       id,
       identity_summary,
       relational_commitments,
       tone_signature,
       growth_notes,
       version,
       updated_by
     )
     VALUES (1, $1, $2, $3, $4, 1, $5)
     ON CONFLICT (id) DO UPDATE SET
       identity_summary = EXCLUDED.identity_summary,
       relational_commitments = EXCLUDED.relational_commitments,
       tone_signature = EXCLUDED.tone_signature,
       growth_notes = EXCLUDED.growth_notes,
       version = soul_state.version + 1,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      params.identitySummary,
      params.relationalCommitments,
      params.toneSignature,
      params.growthNotes,
      updatedBy,
    ]
  );
  return mapSoulStateRow(result.rows[0]);
}
