import type pg from "pg";

export interface SoulQualitySignalRow {
  id: number;
  chat_id: string;
  assistant_message_id: number | null;
  signal_type: string;
  soul_version: number;
  pattern_count: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface SoulQualityStats {
  felt_personal: number;
  felt_generic: number;
  correction: number;
  positive_reaction: number;
  total: number;
  personal_ratio: number;
}

export interface PulseCheckRow {
  id: number;
  chat_id: string;
  status: string;
  personal_ratio: number;
  correction_rate: number;
  signal_counts: Record<string, number>;
  repairs_applied: Record<string, unknown>[];
  soul_version_before: number;
  soul_version_after: number;
  created_at: Date;
}

export interface SoulStateHistoryRow {
  id: number;
  chat_id: string;
  version: number;
  identity_summary: string;
  relational_commitments: string[];
  tone_signature: string[];
  growth_notes: string[];
  change_reason: string;
  created_at: Date;
}

function mapSoulQualitySignalRow(row: Record<string, unknown>): SoulQualitySignalRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    assistant_message_id: (row.assistant_message_id as number | null) ?? null,
    signal_type: row.signal_type as string,
    soul_version: Number(row.soul_version),
    pattern_count: Number(row.pattern_count),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at as Date,
  };
}

function mapPulseCheckRow(row: Record<string, unknown>): PulseCheckRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    status: row.status as string,
    personal_ratio: parseFloat(row.personal_ratio as string),
    correction_rate: parseFloat(row.correction_rate as string),
    signal_counts: (row.signal_counts as Record<string, number>) ?? {},
    repairs_applied: (row.repairs_applied as Record<string, unknown>[]) ?? [],
    soul_version_before: Number(row.soul_version_before),
    soul_version_after: Number(row.soul_version_after),
    created_at: row.created_at as Date,
  };
}

function mapSoulStateHistoryRow(row: Record<string, unknown>): SoulStateHistoryRow {
  return {
    id: row.id as number,
    chat_id: String(row.chat_id),
    version: Number(row.version),
    identity_summary: row.identity_summary as string,
    relational_commitments:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.relational_commitments as string[]) || [],
    tone_signature:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.tone_signature as string[]) || [],
    growth_notes:
      /* v8 ignore next -- defensive: SQL defaults arrays to '{}' */
      (row.growth_notes as string[]) || [],
    change_reason: row.change_reason as string,
    created_at: row.created_at as Date,
  };
}

/**
 * Insert a soul quality feedback signal.
 */
export async function insertSoulQualitySignal(
  pool: pg.Pool,
  params: {
    chatId: string;
    assistantMessageId: number | null;
    signalType: string;
    soulVersion: number;
    patternCount: number;
    metadata: Record<string, unknown>;
  }
): Promise<SoulQualitySignalRow> {
  const result = await pool.query(
    `INSERT INTO soul_quality_signals (
      chat_id, assistant_message_id, signal_type, soul_version, pattern_count, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      params.chatId,
      params.assistantMessageId,
      params.signalType,
      params.soulVersion,
      params.patternCount,
      JSON.stringify(params.metadata),
    ]
  );
  return mapSoulQualitySignalRow(result.rows[0]);
}

/**
 * Get aggregated soul quality stats for a chat within a time window.
 */
export async function getSoulQualityStats(
  pool: pg.Pool,
  chatId: string,
  windowDays: number = 30
): Promise<SoulQualityStats> {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN signal_type = 'felt_personal' THEN 1 ELSE 0 END), 0)::int AS felt_personal,
       COALESCE(SUM(CASE WHEN signal_type = 'felt_generic' THEN 1 ELSE 0 END), 0)::int AS felt_generic,
       COALESCE(SUM(CASE WHEN signal_type = 'correction' THEN 1 ELSE 0 END), 0)::int AS correction,
       COALESCE(SUM(CASE WHEN signal_type = 'positive_reaction' THEN 1 ELSE 0 END), 0)::int AS positive_reaction,
       COUNT(*)::int AS total
     FROM soul_quality_signals
     WHERE chat_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
    [chatId, windowDays]
  );
  const row = result.rows[0];
  const positiveSignals = row.felt_personal + row.positive_reaction;
  const negativeSignals = row.felt_generic;
  const qualityTotal = positiveSignals + negativeSignals;
  return {
    felt_personal: row.felt_personal,
    felt_generic: row.felt_generic,
    correction: row.correction,
    positive_reaction: row.positive_reaction,
    total: row.total,
    personal_ratio: qualityTotal > 0 ? positiveSignals / qualityTotal : 0,
  };
}

/**
 * Get the most recent assistant message ID for a chat (for attaching feedback signals).
 */
export async function getLastAssistantMessageId(
  pool: pg.Pool,
  chatId: string
): Promise<number | null> {
  const result = await pool.query(
    `SELECT id FROM chat_messages
     WHERE chat_id = $1 AND role = 'assistant' AND compacted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
  return result.rows[0]?.id ?? null;
}

// ============================================================================
// Pulse checks (Phase 5: self-healing organism)
// ============================================================================

/**
 * Insert a pulse check diagnosis record.
 */
export async function insertPulseCheck(
  pool: pg.Pool,
  params: {
    chatId: string;
    status: string;
    personalRatio: number;
    correctionRate: number;
    signalCounts: Record<string, number>;
    repairsApplied: Record<string, unknown>[];
    soulVersionBefore: number;
    soulVersionAfter: number;
  }
): Promise<PulseCheckRow> {
  const result = await pool.query(
    `INSERT INTO pulse_checks (
      chat_id, status, personal_ratio, correction_rate,
      signal_counts, repairs_applied, soul_version_before, soul_version_after
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      params.chatId,
      params.status,
      params.personalRatio,
      params.correctionRate,
      JSON.stringify(params.signalCounts),
      JSON.stringify(params.repairsApplied),
      params.soulVersionBefore,
      params.soulVersionAfter,
    ]
  );
  return mapPulseCheckRow(result.rows[0]);
}

/**
 * Get the most recent pulse check time for a chat.
 */
export async function getLastPulseCheckTime(
  pool: pg.Pool,
  chatId: string
): Promise<Date | null> {
  const result = await pool.query(
    `SELECT created_at FROM pulse_checks
     WHERE chat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
  return result.rows[0]?.created_at ?? null;
}

/**
 * Get the most recent pulse check for a chat (for /soul display).
 */
export async function getLastPulseCheck(
  pool: pg.Pool,
  chatId: string
): Promise<PulseCheckRow | null> {
  const result = await pool.query(
    `SELECT * FROM pulse_checks
     WHERE chat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
  if (result.rows.length === 0) return null;
  return mapPulseCheckRow(result.rows[0]);
}

// ============================================================================
// Soul state history (Phase 5: audit trail)
// ============================================================================

/**
 * Record a soul state snapshot for the audit trail.
 */
export async function insertSoulStateHistory(
  pool: pg.Pool,
  params: {
    chatId: string;
    version: number;
    identitySummary: string;
    relationalCommitments: string[];
    toneSignature: string[];
    growthNotes: string[];
    changeReason: string;
  }
): Promise<SoulStateHistoryRow> {
  const result = await pool.query(
    `INSERT INTO soul_state_history (
      chat_id, version, identity_summary, relational_commitments,
      tone_signature, growth_notes, change_reason
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      params.chatId,
      params.version,
      params.identitySummary,
      params.relationalCommitments,
      params.toneSignature,
      params.growthNotes,
      params.changeReason,
    ]
  );
  return mapSoulStateHistoryRow(result.rows[0]);
}
