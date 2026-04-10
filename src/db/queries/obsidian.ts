import type pg from "pg";

// ============================================================================
// Obsidian sync run tracking
// ============================================================================

export interface ObsidianSyncRun {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  files_synced: number;
  files_deleted: number;
  links_resolved: number;
  errors: Array<{ file: string; error: string }>;
}

export async function insertObsidianSyncRun(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO obsidian_sync_runs (status) VALUES ('running') RETURNING id`
  );
  return result.rows[0].id;
}

export async function completeObsidianSyncRun(
  pool: pg.Pool,
  id: string,
  status: "success" | "error",
  filesSynced: number,
  filesDeleted: number,
  linksResolved: number,
  errors: Array<{ file: string; error: string }>
): Promise<void> {
  await pool.query(
    `UPDATE obsidian_sync_runs
     SET finished_at = NOW(), status = $2, files_synced = $3,
         files_deleted = $4, links_resolved = $5, errors = $6::jsonb
     WHERE id = $1`,
    [id, status, filesSynced, filesDeleted, linksResolved, JSON.stringify(errors)]
  );
}

export async function getLatestObsidianSyncRun(
  pool: pg.Pool
): Promise<ObsidianSyncRun | null> {
  const result = await pool.query(
    `SELECT id, started_at, finished_at, status, files_synced, files_deleted,
            links_resolved, errors
     FROM obsidian_sync_runs
     ORDER BY started_at DESC LIMIT 1`
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id as string,
    started_at: row.started_at as Date,
    finished_at: row.finished_at as Date | null,
    status: row.status as string,
    files_synced: row.files_synced as number,
    files_deleted: row.files_deleted as number,
    links_resolved: row.links_resolved as number,
    errors: row.errors as Array<{ file: string; error: string }>,
  };
}

// ============================================================================
// Obsidian artifact upsert + change detection
// ============================================================================

export interface ExistingObsidianArtifact {
  id: string;
  source_path: string;
  content_hash: string | null;
}

/** Load all obsidian-sourced artifacts for change detection */
export async function getObsidianArtifacts(
  pool: pg.Pool
): Promise<ExistingObsidianArtifact[]> {
  const result = await pool.query(
    `SELECT id, source_path, content_hash
     FROM knowledge_artifacts
     WHERE source = 'obsidian' AND source_path IS NOT NULL AND deleted_at IS NULL`
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    source_path: row.source_path as string,
    content_hash: row.content_hash as string | null,
  }));
}

/** Upsert an obsidian-sourced artifact. Returns the artifact ID.
 *  When `embedding` is provided it is stored directly; otherwise the column
 *  is NULLed so the background embed job picks it up. */
export async function upsertObsidianArtifact(
  pool: pg.Pool,
  data: {
    sourcePath: string;
    title: string;
    body: string;
    kind: string;
    contentHash: string;
    duplicateOf?: string;
    embedding?: number[];
  }
): Promise<string> {
  const embeddingVal = data.embedding
    ? `[${data.embedding.join(",")}]`
    : null;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO knowledge_artifacts (source_path, title, body, kind, source, content_hash, duplicate_of, embedding)
     VALUES ($1, $2, $3, $4, 'obsidian', $5, $6, $7::vector)
     ON CONFLICT (source_path) WHERE source_path IS NOT NULL
     DO UPDATE SET
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       kind = EXCLUDED.kind,
       content_hash = EXCLUDED.content_hash,
       duplicate_of = EXCLUDED.duplicate_of,
       embedding = COALESCE(EXCLUDED.embedding, NULL),
       deleted_at = NULL
     RETURNING id`,
    [data.sourcePath, data.title, data.body, data.kind, data.contentHash, data.duplicateOf ?? null, embeddingVal]
  );
  return result.rows[0].id;
}

/** Soft-delete obsidian artifacts not in the active keys list */
export async function softDeleteMissingObsidianArtifacts(
  pool: pg.Pool,
  activeKeys: string[]
): Promise<number> {
  if (activeKeys.length === 0) {
    // All files removed — soft-delete everything
    const result = await pool.query(
      `UPDATE knowledge_artifacts
       SET deleted_at = NOW(), embedding = NULL
       WHERE source = 'obsidian' AND deleted_at IS NULL
       RETURNING id`
    );
    return result.rowCount ?? 0;
  }
  const result = await pool.query(
    `UPDATE knowledge_artifacts
     SET deleted_at = NOW(), embedding = NULL
     WHERE source = 'obsidian'
       AND deleted_at IS NULL
       AND NOT (source_path = ANY($1::text[]))
     RETURNING id`,
    [activeKeys]
  );
  return result.rowCount ?? 0;
}

/** Get counts for sync status */
export async function getObsidianSyncCounts(
  pool: pg.Pool
): Promise<{ total: number; pendingEmbeddings: number }> {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE embedding IS NULL)::int AS pending_embeddings
     FROM knowledge_artifacts
     WHERE source = 'obsidian' AND deleted_at IS NULL`
  );
  return {
    total: result.rows[0].total as number,
    pendingEmbeddings: result.rows[0].pending_embeddings as number,
  };
}
