import type pg from "pg";

// ============================================================================
// Check-ins
// ============================================================================

export type CheckinWindow = "morning" | "afternoon" | "evening" | "event";
export type CheckinTriggerType = "scheduled" | "oura_anomaly" | "journal_pattern";

export interface CheckinRow {
  id: number;
  chat_id: string;
  window: CheckinWindow;
  trigger_type: CheckinTriggerType;
  prompt_text: string;
  artifact_id: string | null;
  responded_at: Date | null;
  ignored: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function insertCheckin(
  pool: pg.Pool,
  data: {
    chatId: string;
    window: CheckinWindow;
    triggerType: CheckinTriggerType;
    promptText: string;
    metadata?: Record<string, unknown>;
  }
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO checkins (chat_id, "window", trigger_type, prompt_text, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [data.chatId, data.window, data.triggerType, data.promptText, data.metadata ?? {}]
  );
  return result.rows[0].id;
}

export async function getLastCheckinForWindow(
  pool: pg.Pool,
  chatId: string,
  window: CheckinWindow,
  sinceHoursAgo: number
): Promise<CheckinRow | null> {
  const result = await pool.query<CheckinRow>(
    `SELECT * FROM checkins
     WHERE chat_id = $1
       AND "window" = $2
       AND created_at > NOW() - MAKE_INTERVAL(hours => $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId, window, sinceHoursAgo]
  );
  return result.rows[0] ?? null;
}

export async function markCheckinResponded(
  pool: pg.Pool,
  checkinId: number,
  artifactId?: string
): Promise<void> {
  await pool.query(
    `UPDATE checkins SET responded_at = NOW(), artifact_id = COALESCE($2, artifact_id)
     WHERE id = $1`,
    [checkinId, artifactId ?? null]
  );
}

export async function markCheckinsIgnored(
  pool: pg.Pool,
  olderThanHours: number
): Promise<number> {
  const result = await pool.query(
    `UPDATE checkins SET ignored = TRUE
     WHERE responded_at IS NULL
       AND ignored = FALSE
       AND created_at < NOW() - MAKE_INTERVAL(hours => $1)`,
    [olderThanHours]
  );
  /* v8 ignore next */
  return result.rowCount ?? 0;
}

export async function getConsecutiveIgnoredCount(
  pool: pg.Pool,
  chatId: string,
  window: CheckinWindow
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `WITH ordered AS (
       SELECT ignored, responded_at,
              ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
       FROM checkins
       WHERE chat_id = $1 AND "window" = $2
     )
     SELECT COUNT(*) AS count FROM ordered
     WHERE ignored = TRUE
       AND rn <= (
         SELECT COALESCE(MIN(rn) - 1, (SELECT MAX(rn) FROM ordered))
         FROM ordered
         WHERE responded_at IS NOT NULL
       )`,
    [chatId, window]
  );
  /* v8 ignore next */
  return parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function findOrCreateDailyLogArtifact(
  pool: pg.Pool,
  dateStr: string,
  tags: string[]
): Promise<{ id: string; body: string; version: number }> {
  const title = `Daily Log — ${dateStr}`;

  // Try to find existing
  const existing = await pool.query<{ id: string; body: string; version: number }>(
    `SELECT id, body, version FROM knowledge_artifacts
     WHERE kind = 'log' AND title = $1
     LIMIT 1`,
    [title]
  );

  if (existing.rows[0]) return existing.rows[0];

  // Create new
  const result = await pool.query<{ id: string; body: string; version: number }>(
    `INSERT INTO knowledge_artifacts (kind, title, body)
     VALUES ('log', $1, $2)
     RETURNING id, body, version`,
    [title, `# ${title}\n`]
  );

  const artifactId = result.rows[0].id;

  // Add tags
  for (const tag of tags) {
    await pool.query(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [tag.toLowerCase()]
    );
    await pool.query(
      `INSERT INTO artifact_tags (artifact_id, tag_id)
       SELECT $1, id FROM tags WHERE name = $2
       ON CONFLICT DO NOTHING`,
      [artifactId, tag.toLowerCase()]
    );
  }

  return result.rows[0];
}

export async function appendToDailyLog(
  pool: pg.Pool,
  artifactId: string,
  section: string
): Promise<{ version: number }> {
  const result = await pool.query<{ version: number }>(
    `UPDATE knowledge_artifacts
     SET body = CASE
       WHEN body = '' THEN $2
       ELSE body || E'\\n\\n' || $2
     END
     WHERE id = $1
     RETURNING version`,
    [artifactId, section]
  );
  return result.rows[0];
}
