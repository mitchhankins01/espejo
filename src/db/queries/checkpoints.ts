import type pg from "pg";

export interface CheckpointRow {
  id: number;
  kind: string;
  trigger: string;
  body_signal: string | null;
  part_voice: string | null;
  resolution: string | null;
  payload: Record<string, unknown>;
  source: string;
  chat_id: string | null;
  occurred_at: Date;
  local_date: string;
  created_at: Date;
}

export interface InsertCheckpointParams {
  kind: string;
  trigger: string;
  bodySignal?: string | null;
  partVoice?: string | null;
  resolution?: string | null;
  payload?: Record<string, unknown>;
  source?: string;
  chatId?: string | null;
  occurredAt?: Date;
  localDate: string;
}

export async function insertCheckpoint(
  pool: pg.Pool,
  params: InsertCheckpointParams
): Promise<CheckpointRow> {
  const result = await pool.query<CheckpointRow>(
    `INSERT INTO checkpoints
       (kind, trigger, body_signal, part_voice, resolution, payload, source, chat_id, occurred_at, local_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10)
     RETURNING *`,
    [
      params.kind,
      params.trigger,
      params.bodySignal ?? null,
      params.partVoice ?? null,
      params.resolution ?? null,
      JSON.stringify(params.payload ?? {}),
      params.source ?? "telegram",
      params.chatId ?? null,
      params.occurredAt ?? null,
      params.localDate,
    ]
  );
  return result.rows[0];
}

/**
 * Insert a checkpoint, returning null when the unique dedup index hits.
 * Used by backfill to make repeated runs idempotent.
 */
export async function insertCheckpointIdempotent(
  pool: pg.Pool,
  params: InsertCheckpointParams
): Promise<CheckpointRow | null> {
  const result = await pool.query<CheckpointRow>(
    `INSERT INTO checkpoints
       (kind, trigger, body_signal, part_voice, resolution, payload, source, chat_id, occurred_at, local_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10)
     ON CONFLICT (kind, trigger, (COALESCE(body_signal, '')), (COALESCE(part_voice, '')), occurred_at) DO NOTHING
     RETURNING *`,
    [
      params.kind,
      params.trigger,
      params.bodySignal ?? null,
      params.partVoice ?? null,
      params.resolution ?? null,
      JSON.stringify(params.payload ?? {}),
      params.source ?? "vault-backfill",
      params.chatId ?? null,
      params.occurredAt ?? null,
      params.localDate,
    ]
  );
  return result.rows[0] ?? null;
}

/**
 * Find a recent duplicate within the given minutes window. Used as a cheap
 * insurance against MCP-LLM re-running log_checkpoint on ambiguous follow-ups.
 */
export async function findRecentDuplicate(
  pool: pg.Pool,
  params: {
    kind: string;
    trigger: string;
    bodySignal: string | null;
    partVoice: string | null;
    withinMinutes: number;
  }
): Promise<CheckpointRow | null> {
  const result = await pool.query<CheckpointRow>(
    `SELECT * FROM checkpoints
     WHERE kind = $1
       AND lower(trigger) = lower($2)
       AND COALESCE(lower(body_signal), '') = COALESCE(lower($3), '')
       AND COALESCE(lower(part_voice), '') = COALESCE(lower($4), '')
       AND occurred_at > NOW() - ($5 || ' minutes')::interval
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [
      params.kind,
      params.trigger,
      params.bodySignal,
      params.partVoice,
      String(params.withinMinutes),
    ]
  );
  return result.rows[0] ?? null;
}

export async function getCheckpointsForDate(
  pool: pg.Pool,
  localDate: string,
  kind?: string
): Promise<CheckpointRow[]> {
  if (kind) {
    const result = await pool.query<CheckpointRow>(
      `SELECT * FROM checkpoints
       WHERE local_date = $1 AND kind = $2
       ORDER BY occurred_at ASC`,
      [localDate, kind]
    );
    return result.rows;
  }
  const result = await pool.query<CheckpointRow>(
    `SELECT * FROM checkpoints
     WHERE local_date = $1
     ORDER BY occurred_at ASC`,
    [localDate]
  );
  return result.rows;
}
