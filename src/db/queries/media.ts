import type pg from "pg";

// ============================================================================
// Web journaling: Media queries
// ============================================================================

export interface MediaRow {
  id: number;
  entry_id: number;
  type: string;
  md5: string | null;
  file_size: number | null;
  dimensions: { width: number; height: number } | null;
  storage_key: string | null;
  url: string | null;
}

export async function insertMedia(
  pool: pg.Pool,
  data: {
    entry_id: number;
    type: string;
    storage_key: string;
    url: string;
    file_size?: number;
    dimensions?: { width: number; height: number };
  }
): Promise<MediaRow> {
  const result = await pool.query(
    `INSERT INTO media (entry_id, type, storage_key, url, file_size, dimensions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, entry_id, type, md5, file_size, dimensions, storage_key, url`,
    [
      data.entry_id,
      data.type,
      data.storage_key,
      data.url,
      data.file_size ?? null,
      data.dimensions ? JSON.stringify(data.dimensions) : null,
    ]
  );
  return result.rows[0] as MediaRow;
}

export async function getMediaForEntry(
  pool: pg.Pool,
  entryId: number
): Promise<MediaRow[]> {
  const result = await pool.query(
    `SELECT id, entry_id, type, md5, file_size, dimensions, storage_key, url
     FROM media WHERE entry_id = $1 ORDER BY id`,
    [entryId]
  );
  return result.rows as MediaRow[];
}

export async function deleteMedia(
  pool: pg.Pool,
  id: number
): Promise<{ deleted: boolean; storage_key: string | null }> {
  const result = await pool.query(
    `DELETE FROM media WHERE id = $1 RETURNING storage_key`,
    [id]
  );
  /* v8 ignore next */
  if ((result.rowCount ?? 0) === 0) {
    return { deleted: false, storage_key: null };
  }
  return {
    deleted: true,
    /* v8 ignore next */
    storage_key: (result.rows[0].storage_key as string | null) ?? null,
  };
}

// ============================================================================
// Web journaling: Version-guarded embedding update
// ============================================================================

export async function updateEntryEmbeddingIfVersionMatches(
  pool: pg.Pool,
  uuid: string,
  version: number,
  embedding: number[]
): Promise<boolean> {
  const embeddingStr = `[${embedding.join(",")}]`;
  const result = await pool.query(
    `UPDATE entries SET embedding = $1::vector
     WHERE uuid = $2 AND version = $3`,
    [embeddingStr, uuid, version]
  );
  /* v8 ignore next */
  return (result.rowCount ?? 0) > 0;
}
