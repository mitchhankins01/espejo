import type pg from "pg";

import type { TagCountRow } from "./entries.js";

// ============================================================================
// Knowledge artifact types
// ============================================================================

export type ArtifactKind = "insight" | "reference" | "note" | "project" | "review";

export type ArtifactSource = "web" | "obsidian" | "mcp" | "telegram";

export type ArtifactStatus = "pending" | "approved";

export interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  tags: string[];
  has_embedding: boolean;
  status: ArtifactStatus;
  source: ArtifactSource;
  source_path: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  source_entry_uuids: string[];
}

export interface ArtifactSearchResultRow {
  id: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  tags: string[];
  has_embedding: boolean;
  rrf_score: number;
  has_semantic: boolean;
  has_fulltext: boolean;
  created_at: Date;
  updated_at: Date;
  version: number;
}

export interface ArtifactTitleRow {
  id: string;
  title: string;
  kind: ArtifactKind;
}

export interface RelatedArtifactRow {
  id: string;
  title: string;
  kind: ArtifactKind;
}

export interface SimilarArtifactRow extends RelatedArtifactRow {
  similarity: number;
}

export interface ArtifactGraphRow {
  id: string;
  title: string;
  kind: ArtifactKind;
  tags: string[];
  has_embedding: boolean;
}

export interface ArtifactGraphData {
  artifacts: ArtifactGraphRow[];
  explicitLinks: { source_id: string; target_id: string }[];
  sharedSources: { artifact_id_1: string; artifact_id_2: string }[];
  similarities: { id_1: string; id_2: string; similarity: number }[];
}

export interface ListArtifactsFilters {
  kind?: ArtifactKind;
  source?: ArtifactSource;
  tags?: string[];
  tags_mode?: "any" | "all";
  limit?: number;
  offset?: number;
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Normalize tags: trim, lowercase, dedupe, stable sort.
 */
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result.sort();
}

// ============================================================================
// Private helpers
// ============================================================================

export async function upsertArtifactTags(
  pool: pg.Pool,
  artifactId: string,
  tags: string[]
): Promise<void> {
  if (tags.length === 0) return;
  for (const tag of tags) {
    await pool.query(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [tag]
    );
    await pool.query(
      `INSERT INTO artifact_tags (artifact_id, tag_id)
       SELECT $1, id FROM tags WHERE name = $2
       ON CONFLICT DO NOTHING`,
      [artifactId, tag]
    );
  }
}

async function getArtifactTagsMap(
  pool: pg.Pool,
  artifactIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  /* v8 ignore next */
  if (artifactIds.length === 0) return map;

  const result = await pool.query(
    `SELECT at.artifact_id, t.name
     FROM artifact_tags at
     JOIN tags t ON t.id = at.tag_id
     WHERE at.artifact_id = ANY($1::uuid[])
     ORDER BY at.artifact_id, t.name`,
    [artifactIds]
  );

  for (const row of result.rows) {
    const aid = row.artifact_id as string;
    if (!map.has(aid)) map.set(aid, []);
    map.get(aid)!.push(row.name as string);
  }

  return map;
}

async function getArtifactSourcesMap(
  pool: pg.Pool,
  artifactIds: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  /* v8 ignore next */
  if (artifactIds.length === 0) return map;

  const result = await pool.query(
    `SELECT artifact_id, entry_uuid FROM knowledge_artifact_sources
     WHERE artifact_id = ANY($1::uuid[])
     ORDER BY artifact_id, entry_uuid`,
    [artifactIds]
  );

  for (const row of result.rows) {
    const aid = row.artifact_id as string;
    if (!map.has(aid)) map.set(aid, []);
    map.get(aid)!.push(row.entry_uuid as string);
  }

  return map;
}

// ============================================================================
// Query functions
// ============================================================================

export async function listArtifactTags(
  pool: pg.Pool
): Promise<TagCountRow[]> {
  const result = await pool.query(
    `SELECT t.name, COUNT(at.artifact_id)::int AS count
     FROM tags t
     JOIN artifact_tags at ON at.tag_id = t.id
     JOIN knowledge_artifacts ka ON ka.id = at.artifact_id
     WHERE ka.deleted_at IS NULL
     GROUP BY t.id, t.name
     ORDER BY count DESC, t.name ASC`
  );
  return result.rows;
}

export async function listArtifactTitles(
  pool: pg.Pool
): Promise<ArtifactTitleRow[]> {
  const result = await pool.query(
    `SELECT id, title, kind
     FROM knowledge_artifacts
     WHERE deleted_at IS NULL
     ORDER BY updated_at DESC`
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    kind: row.kind as ArtifactKind,
  }));
}

export async function findArtifactByKindAndTitle(
  pool: pg.Pool,
  kind: ArtifactKind,
  title: string
): Promise<ArtifactRow | null> {
  const result = await pool.query(
    `SELECT id, kind, title, body, (embedding IS NOT NULL) AS has_embedding,
            status, source, source_path, deleted_at, created_at, updated_at, version
     FROM knowledge_artifacts
     WHERE kind = $1 AND title = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [kind, title]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const id = row.id as string;
  const [sourcesMap, tagsMap] = await Promise.all([
    getArtifactSourcesMap(pool, [id]),
    getArtifactTagsMap(pool, [id]),
  ]);
  return {
    id,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    /* v8 ignore next */
    tags: tagsMap.get(id) ?? [],
    has_embedding: row.has_embedding as boolean,
    /* v8 ignore next */
    status: (row.status as ArtifactStatus) ?? "approved",
    source: row.source as ArtifactSource,
    source_path: row.source_path as string | null,
    deleted_at: row.deleted_at as Date | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
    /* v8 ignore next */
    source_entry_uuids: sourcesMap.get(id) ?? [],
  };
}

export async function getRecentReviewArtifacts(
  pool: pg.Pool,
  dateFrom: string,
  dateTo: string,
  limit: number = 20
): Promise<ArtifactRow[]> {
  const result = await pool.query(
    `SELECT id, kind, title, body, (embedding IS NOT NULL) AS has_embedding,
            status, source, source_path, deleted_at, created_at, updated_at, version
     FROM knowledge_artifacts
     WHERE kind = 'review'
       AND deleted_at IS NULL
       AND created_at >= $1::date
       AND created_at < ($2::date + interval '1 day')
     ORDER BY created_at DESC
     LIMIT $3`,
    [dateFrom, dateTo, limit]
  );

  const ids = result.rows.map((r) => r.id as string);
  const [sourcesMap, tagsMap] = await Promise.all([
    getArtifactSourcesMap(pool, ids),
    getArtifactTagsMap(pool, ids),
  ]);

  return result.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    /* v8 ignore next */
    tags: tagsMap.get(row.id as string) ?? [],
    has_embedding: row.has_embedding as boolean,
    /* v8 ignore next */
    status: (row.status as ArtifactStatus) ?? "approved",
    source: row.source as ArtifactSource,
    source_path: row.source_path as string | null,
    deleted_at: row.deleted_at as Date | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
    /* v8 ignore next */
    source_entry_uuids: sourcesMap.get(row.id as string) ?? [],
  }));
}

export async function resolveArtifactTitleToId(
  pool: pg.Pool,
  title: string
): Promise<string | null> {
  const result = await pool.query(
    `SELECT id
     FROM knowledge_artifacts
     WHERE lower(title) = lower($1)
       AND deleted_at IS NULL
     LIMIT 1`,
    [title.trim()]
  );
  return (result.rows[0]?.id as string | undefined) ?? null;
}

export async function syncExplicitLinks(
  pool: pg.Pool,
  sourceId: string,
  targetIds: string[]
): Promise<void> {
  await pool.query(`DELETE FROM artifact_links WHERE source_id = $1`, [sourceId]);

  const deduped = Array.from(
    new Set(
      targetIds
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && id !== sourceId)
    )
  );

  /* v8 ignore next */
  if (deduped.length === 0) return;

  await pool.query(
    `INSERT INTO artifact_links (source_id, target_id)
     SELECT $1, target_id
     FROM unnest($2::uuid[]) AS target_id
     ON CONFLICT DO NOTHING`,
    [sourceId, deduped]
  );
}

export async function getExplicitLinks(
  pool: pg.Pool,
  artifactId: string
): Promise<RelatedArtifactRow[]> {
  const result = await pool.query(
    `SELECT ka.id, ka.title, ka.kind
     FROM knowledge_artifacts ka
     JOIN artifact_links al ON al.target_id = ka.id
     WHERE al.source_id = $1
       AND ka.deleted_at IS NULL
     ORDER BY ka.title ASC`,
    [artifactId]
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    kind: row.kind as ArtifactKind,
  }));
}

export async function getExplicitBacklinks(
  pool: pg.Pool,
  artifactId: string
): Promise<RelatedArtifactRow[]> {
  const result = await pool.query(
    `SELECT ka.id, ka.title, ka.kind
     FROM knowledge_artifacts ka
     JOIN artifact_links al ON al.source_id = ka.id
     WHERE al.target_id = $1
       AND ka.deleted_at IS NULL
     ORDER BY ka.title ASC`,
    [artifactId]
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    kind: row.kind as ArtifactKind,
  }));
}

export async function findSimilarArtifacts(
  pool: pg.Pool,
  artifactId: string,
  limit: number,
  minSimilarity: number
): Promise<SimilarArtifactRow[]> {
  const result = await pool.query(
    `WITH source AS (
       SELECT id, embedding
       FROM knowledge_artifacts
       WHERE id = $1
     ),
     ranked AS (
       SELECT
         ka.id,
         ka.title,
         ka.kind,
         1 - (ka.embedding <=> s.embedding) AS similarity
       FROM knowledge_artifacts ka
       CROSS JOIN source s
       WHERE ka.id != s.id
         AND ka.embedding IS NOT NULL
         AND s.embedding IS NOT NULL
         AND ka.deleted_at IS NULL
         AND ka.status = 'approved'
       ORDER BY ka.embedding <=> s.embedding
       LIMIT $2
     )
     SELECT id, title, kind, similarity
     FROM ranked
     WHERE similarity >= $3
     ORDER BY similarity DESC`,
    [artifactId, limit, minSimilarity]
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    kind: row.kind as ArtifactKind,
    similarity: parseFloat(String(row.similarity)),
  }));
}

export async function createArtifact(
  pool: pg.Pool,
  data: {
    kind: ArtifactKind;
    title: string;
    body: string;
    tags?: string[];
    source_entry_uuids?: string[];
    source?: ArtifactSource;
    status?: ArtifactStatus;
  }
): Promise<ArtifactRow> {
  const tags = normalizeTags(data.tags ?? []);

  const columns = ["kind", "title", "body"];
  const values: string[] = [data.kind, data.title, data.body];

  if (data.source) {
    columns.push("source");
    values.push(data.source);
  }
  if (data.status) {
    columns.push("status");
    values.push(data.status);
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const result = await pool.query(
    `INSERT INTO knowledge_artifacts (${columns.join(", ")})
     VALUES (${placeholders})
     RETURNING id, kind, title, body, (embedding IS NOT NULL) AS has_embedding,
               status, source, source_path, deleted_at, created_at, updated_at, version`,
    values
  );

  const row = result.rows[0];
  const id = row.id as string;

  await upsertArtifactTags(pool, id, tags);

  if (data.source_entry_uuids && data.source_entry_uuids.length > 0) {
    for (const uuid of data.source_entry_uuids) {
      await pool.query(
        `INSERT INTO knowledge_artifact_sources (artifact_id, entry_uuid)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, uuid]
      );
    }
  }

  return {
    id,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    tags,
    has_embedding: row.has_embedding as boolean,
    /* v8 ignore next */
    status: (row.status as ArtifactStatus) ?? "approved",
    source: row.source as ArtifactSource,
    source_path: row.source_path as string | null,
    deleted_at: row.deleted_at as Date | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
    source_entry_uuids: data.source_entry_uuids ?? [],
  };
}

export async function updateArtifact(
  pool: pg.Pool,
  id: string,
  expectedVersion: number,
  data: {
    kind?: ArtifactKind;
    title?: string;
    body?: string;
    tags?: string[];
    source_entry_uuids?: string[];
  }
): Promise<ArtifactRow | "version_conflict" | "source_protected" | null> {
  // Fetch current state to detect what changed
  const current = await pool.query(
    `SELECT title, body, kind, version, source FROM knowledge_artifacts WHERE id = $1`,
    [id]
  );
  if (current.rows.length === 0) return null;

  const currentRow = current.rows[0];
  if (currentRow.source === "obsidian") return "source_protected";
  if ((currentRow.version as number) !== expectedVersion) return "version_conflict";

  const newTitle = data.title ?? (currentRow.title as string);
  const newBody = data.body ?? (currentRow.body as string);
  const newKind = data.kind ?? (currentRow.kind as ArtifactKind);

  const titleChanged = newTitle !== (currentRow.title as string);
  const bodyChanged = newBody !== (currentRow.body as string);
  const contentChanged = titleChanged || bodyChanged;

  // Build SET clauses
  const setClauses: string[] = [];
  const setParams: unknown[] = [id];
  let paramIdx = 1;

  paramIdx++;
  setClauses.push(`kind = $${paramIdx}`);
  setParams.push(newKind);

  paramIdx++;
  setClauses.push(`title = $${paramIdx}`);
  setParams.push(newTitle);

  paramIdx++;
  setClauses.push(`body = $${paramIdx}`);
  setParams.push(newBody);

  // Invalidate embedding if content changed
  if (contentChanged) {
    setClauses.push(`embedding = NULL`);
    setClauses.push(`embedding_model = 'text-embedding-3-small'`);
  }

  const result = await pool.query(
    `UPDATE knowledge_artifacts
     SET ${setClauses.join(", ")}
     WHERE id = $1
     RETURNING id, kind, title, body, (embedding IS NOT NULL) AS has_embedding,
               status, source, source_path, deleted_at, created_at, updated_at, version`,
    setParams
  );

  const row = result.rows[0];

  // Update tags if provided
  if (data.tags !== undefined) {
    const newTags = normalizeTags(data.tags);
    await pool.query(`DELETE FROM artifact_tags WHERE artifact_id = $1`, [id]);
    await upsertArtifactTags(pool, id, newTags);
  }

  // Update source links if provided
  if (data.source_entry_uuids !== undefined) {
    await pool.query(
      `DELETE FROM knowledge_artifact_sources WHERE artifact_id = $1`,
      [id]
    );
    for (const uuid of data.source_entry_uuids) {
      await pool.query(
        `INSERT INTO knowledge_artifact_sources (artifact_id, entry_uuid)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, uuid]
      );
    }
  }

  // Fetch source UUIDs
  const sources = await pool.query(
    `SELECT entry_uuid FROM knowledge_artifact_sources WHERE artifact_id = $1 ORDER BY entry_uuid`,
    [id]
  );

  // Fetch tags
  const tagsMap = await getArtifactTagsMap(pool, [id]);

  return {
    id: row.id as string,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    /* v8 ignore next */
    tags: tagsMap.get(id) ?? [],
    has_embedding: row.has_embedding as boolean,
    /* v8 ignore next */
    status: (row.status as ArtifactStatus) ?? "approved",
    source: row.source as ArtifactSource,
    source_path: row.source_path as string | null,
    deleted_at: row.deleted_at as Date | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
    source_entry_uuids: sources.rows.map((r) => r.entry_uuid as string),
  };
}

export async function deleteArtifact(
  pool: pg.Pool,
  id: string
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM knowledge_artifacts WHERE id = $1`,
    [id]
  );
  /* v8 ignore next */
  return (result.rowCount ?? 0) > 0;
}

export async function getArtifactById(
  pool: pg.Pool,
  id: string
): Promise<ArtifactRow | null> {
  const result = await pool.query(
    `SELECT id, kind, title, body, (embedding IS NOT NULL) AS has_embedding,
            status, source, source_path, deleted_at, created_at, updated_at, version
     FROM knowledge_artifacts WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const sources = await pool.query(
    `SELECT entry_uuid FROM knowledge_artifact_sources WHERE artifact_id = $1 ORDER BY entry_uuid`,
    [id]
  );
  const tagsMap = await getArtifactTagsMap(pool, [id]);

  return {
    id: row.id as string,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    /* v8 ignore next */
    tags: tagsMap.get(id) ?? [],
    has_embedding: row.has_embedding as boolean,
    /* v8 ignore next */
    status: (row.status as ArtifactStatus) ?? "approved",
    source: row.source as ArtifactSource,
    source_path: row.source_path as string | null,
    deleted_at: row.deleted_at as Date | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
    source_entry_uuids: sources.rows.map((r) => r.entry_uuid as string),
  };
}

export async function listArtifacts(
  pool: pg.Pool,
  filters: ListArtifactsFilters
): Promise<ArtifactRow[]> {
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 0;

  if (filters.kind) {
    paramIdx++;
    whereClauses.push(`kind = $${paramIdx}`);
    params.push(filters.kind);
  }

  if (filters.source) {
    paramIdx++;
    whereClauses.push(`ka.source = $${paramIdx}`);
    params.push(filters.source);
  }

  if (filters.tags && filters.tags.length > 0) {
    paramIdx++;
    const mode = filters.tags_mode ?? "any";
    if (mode === "all") {
      whereClauses.push(
        `(SELECT COUNT(DISTINCT t.name) FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = ka.id AND t.name = ANY($${paramIdx}::text[])) = array_length($${paramIdx}::text[], 1)`
      );
    } else {
      whereClauses.push(
        `EXISTS (SELECT 1 FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = ka.id AND t.name = ANY($${paramIdx}::text[]))`
      );
    }
    params.push(normalizeTags(filters.tags));
  }

  whereClauses.push(`ka.deleted_at IS NULL`);
  const whereClause = "WHERE " + whereClauses.join(" AND ");
  const limit = Math.min(filters.limit ?? 20, 100);
  const offset = filters.offset ?? 0;

  paramIdx++;
  params.push(limit);
  const limitParam = paramIdx;

  paramIdx++;
  params.push(offset);
  const offsetParam = paramIdx;

  const result = await pool.query(
    `SELECT id, kind, title, body, (embedding IS NOT NULL) AS has_embedding,
            status, source, source_path, deleted_at, created_at, updated_at, version
     FROM knowledge_artifacts ka
     ${whereClause}
     ORDER BY updated_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params
  );

  // Batch-fetch source UUIDs and tags
  const ids = result.rows.map((r) => r.id as string);
  const [sourcesMap, tagsMap] = await Promise.all([
    getArtifactSourcesMap(pool, ids),
    getArtifactTagsMap(pool, ids),
  ]);

  return result.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    /* v8 ignore next */
    tags: tagsMap.get(row.id as string) ?? [],
    has_embedding: row.has_embedding as boolean,
    /* v8 ignore next */
    status: (row.status as ArtifactStatus) ?? "approved",
    source: row.source as ArtifactSource,
    source_path: row.source_path as string | null,
    deleted_at: row.deleted_at as Date | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
    /* v8 ignore next */
    source_entry_uuids: sourcesMap.get(row.id as string) ?? [],
  }));
}

export async function countArtifacts(
  pool: pg.Pool,
  filters: Pick<ListArtifactsFilters, "kind" | "source" | "tags" | "tags_mode">
): Promise<number> {
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 0;

  if (filters.kind) {
    paramIdx++;
    whereClauses.push(`kind = $${paramIdx}`);
    params.push(filters.kind);
  }

  if (filters.source) {
    paramIdx++;
    whereClauses.push(`ka.source = $${paramIdx}`);
    params.push(filters.source);
  }

  if (filters.tags && filters.tags.length > 0) {
    paramIdx++;
    const mode = filters.tags_mode ?? "any";
    if (mode === "all") {
      whereClauses.push(
        `(SELECT COUNT(DISTINCT t.name) FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = ka.id AND t.name = ANY($${paramIdx}::text[])) = array_length($${paramIdx}::text[], 1)`
      );
    } else {
      whereClauses.push(
        `EXISTS (SELECT 1 FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = ka.id AND t.name = ANY($${paramIdx}::text[]))`
      );
    }
    params.push(normalizeTags(filters.tags));
  }

  whereClauses.push(`ka.deleted_at IS NULL`);
  const whereClause = "WHERE " + whereClauses.join(" AND ");
  const result = await pool.query(
    `SELECT count(*)::int AS total FROM knowledge_artifacts ka ${whereClause}`,
    params
  );
  return result.rows[0].total as number;
}

export async function searchArtifacts(
  pool: pg.Pool,
  queryEmbedding: number[],
  queryText: string,
  filters: { kind?: ArtifactKind; source?: ArtifactSource; tags?: string[]; tags_mode?: "any" | "all" },
  limit: number
): Promise<ArtifactSearchResultRow[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];
  let paramIdx = 3; // $1=embedding, $2=query text, $3=limit

  if (filters.kind) {
    paramIdx++;
    filterClauses.push(`a.kind = $${paramIdx}`);
    filterParams.push(filters.kind);
  }

  if (filters.source) {
    paramIdx++;
    filterClauses.push(`a.source = $${paramIdx}`);
    filterParams.push(filters.source);
  }

  if (filters.tags && filters.tags.length > 0) {
    paramIdx++;
    const mode = filters.tags_mode ?? "any";
    if (mode === "all") {
      filterClauses.push(
        `(SELECT COUNT(DISTINCT t.name) FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = a.id AND t.name = ANY($${paramIdx}::text[])) = array_length($${paramIdx}::text[], 1)`
      );
    } else {
      filterClauses.push(
        `EXISTS (SELECT 1 FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = a.id AND t.name = ANY($${paramIdx}::text[]))`
      );
    }
    filterParams.push(normalizeTags(filters.tags));
  }

  const filterWhere = filterClauses.length > 0 ? "AND " + filterClauses.join(" AND ") : "";

  const sql = `
    WITH params AS (
      SELECT
        $1::vector AS query_embedding,
        plainto_tsquery('english', $2) AS ts_query,
        (
          SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL::tsquery
            ELSE to_tsquery('english', string_agg(token || ':*', ' & '))
          END
          FROM regexp_split_to_table(
            regexp_replace(lower($2), '[^a-z0-9\\s]+', ' ', 'g'),
            '[[:space:]]+'
          ) AS token
          WHERE token <> ''
        ) AS prefix_query
    ),
    semantic AS (
      SELECT a.id,
             ROW_NUMBER() OVER (ORDER BY a.embedding <=> p.query_embedding) AS rank_s
      FROM knowledge_artifacts a, params p
      WHERE a.embedding IS NOT NULL
        AND a.deleted_at IS NULL
        AND a.status = 'approved'
      ${filterWhere}
      ORDER BY a.embedding <=> p.query_embedding
      LIMIT 20
    ),
    fulltext AS (
      SELECT a.id,
             ROW_NUMBER() OVER (
               ORDER BY GREATEST(
                 COALESCE(ts_rank(a.tsv, p.ts_query), 0),
                 COALESCE(ts_rank(a.tsv, p.prefix_query), 0)
               ) DESC
             ) AS rank_f
      FROM knowledge_artifacts a, params p
      WHERE (a.tsv @@ p.ts_query
         OR (p.prefix_query IS NOT NULL AND a.tsv @@ p.prefix_query))
        AND a.deleted_at IS NULL
        AND a.status = 'approved'
      ${filterWhere}
      LIMIT 20
    )
    SELECT
      a.id, a.kind, a.title, a.body,
      (a.embedding IS NOT NULL) AS has_embedding,
      a.created_at, a.updated_at, a.version,
      COALESCE(1.0 / (60 + s.rank_s), 0) + COALESCE(1.0 / (60 + f.rank_f), 0) AS rrf_score,
      s.id IS NOT NULL AS has_semantic,
      f.id IS NOT NULL AS has_fulltext
    FROM knowledge_artifacts a
    LEFT JOIN semantic s ON a.id = s.id
    LEFT JOIN fulltext f ON a.id = f.id
    WHERE s.id IS NOT NULL OR f.id IS NOT NULL
    ORDER BY rrf_score DESC
    LIMIT $3
  `;

  const result = await pool.query(sql, [
    embeddingStr,
    queryText,
    limit,
    ...filterParams,
  ]);

  const ids = result.rows.map((r) => r.id as string);
  const tagsMap = await getArtifactTagsMap(pool, ids);

  return result.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    /* v8 ignore next */
    tags: tagsMap.get(row.id as string) ?? [],
    has_embedding: row.has_embedding as boolean,
    rrf_score: parseFloat(row.rrf_score as string),
    has_semantic: row.has_semantic as boolean,
    has_fulltext: row.has_fulltext as boolean,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
  }));
}

export async function searchArtifactsKeyword(
  pool: pg.Pool,
  queryText: string,
  filters: { kind?: ArtifactKind; source?: ArtifactSource; tags?: string[]; tags_mode?: "any" | "all" },
  limit: number
): Promise<ArtifactSearchResultRow[]> {
  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];
  let paramIdx = 2; // $1=query text, $2=limit

  if (filters.kind) {
    paramIdx++;
    filterClauses.push(`a.kind = $${paramIdx}`);
    filterParams.push(filters.kind);
  }

  if (filters.source) {
    paramIdx++;
    filterClauses.push(`a.source = $${paramIdx}`);
    filterParams.push(filters.source);
  }

  if (filters.tags && filters.tags.length > 0) {
    paramIdx++;
    const mode = filters.tags_mode ?? "any";
    if (mode === "all") {
      filterClauses.push(
        `(SELECT COUNT(DISTINCT t.name) FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = a.id AND t.name = ANY($${paramIdx}::text[])) = array_length($${paramIdx}::text[], 1)`
      );
    } else {
      filterClauses.push(
        `EXISTS (SELECT 1 FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = a.id AND t.name = ANY($${paramIdx}::text[]))`
      );
    }
    filterParams.push(normalizeTags(filters.tags));
  }

  const filterWhere = filterClauses.length > 0 ? "AND " + filterClauses.join(" AND ") : "";

  const sql = `
    WITH params AS (
      SELECT
        lower($1) AS q_lower,
        plainto_tsquery('english', $1) AS ts_query,
        (
          SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL::tsquery
            ELSE to_tsquery('english', string_agg(token || ':*', ' & '))
          END
          FROM regexp_split_to_table(
            regexp_replace(lower($1), '[^a-z0-9\\s]+', ' ', 'g'),
            '[[:space:]]+'
          ) AS token
          WHERE token <> ''
        ) AS prefix_query
    ),
    ranked AS (
      SELECT
        a.id,
        GREATEST(
          COALESCE(ts_rank(a.tsv, p.ts_query), 0),
          COALESCE(ts_rank(a.tsv, p.prefix_query), 0),
          CASE WHEN lower(a.title) LIKE '%' || p.q_lower || '%' THEN 0.4 ELSE 0 END,
          CASE WHEN lower(a.body) LIKE '%' || p.q_lower || '%' THEN 0.1 ELSE 0 END
        ) AS rank_score
      FROM knowledge_artifacts a, params p
      WHERE (
        a.tsv @@ p.ts_query
        OR (p.prefix_query IS NOT NULL AND a.tsv @@ p.prefix_query)
        OR lower(a.title) LIKE '%' || p.q_lower || '%'
        OR lower(a.body) LIKE '%' || p.q_lower || '%'
      )
        AND a.deleted_at IS NULL
        AND a.status = 'approved'
      ${filterWhere}
    )
    SELECT
      a.id, a.kind, a.title, a.body,
      (a.embedding IS NOT NULL) AS has_embedding,
      a.created_at, a.updated_at, a.version,
      r.rank_score AS rrf_score,
      false AS has_semantic,
      true AS has_fulltext
    FROM ranked r
    JOIN knowledge_artifacts a ON a.id = r.id
    ORDER BY r.rank_score DESC, a.updated_at DESC
    LIMIT $2
  `;

  const result = await pool.query(sql, [queryText, limit, ...filterParams]);

  const ids = result.rows.map((r) => r.id as string);
  const tagsMap = await getArtifactTagsMap(pool, ids);

  return result.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as ArtifactKind,
    title: row.title as string,
    body: row.body as string,
    /* v8 ignore next */
    tags: tagsMap.get(row.id as string) ?? [],
    has_embedding: row.has_embedding as boolean,
    rrf_score: parseFloat(row.rrf_score as string),
    has_semantic: row.has_semantic as boolean,
    has_fulltext: row.has_fulltext as boolean,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    version: row.version as number,
  }));
}

export async function getArtifactGraph(
  pool: pg.Pool
): Promise<ArtifactGraphData> {
  const [artifactResult, explicitResult, sharedSourceResult, similarityResult] =
    await Promise.all([
      pool.query(
        `SELECT id, title, kind, (embedding IS NOT NULL) AS has_embedding
         FROM knowledge_artifacts
         WHERE deleted_at IS NULL
         ORDER BY updated_at DESC`
      ),
      pool.query(
        `SELECT al.source_id, al.target_id
         FROM artifact_links al
         JOIN knowledge_artifacts ka1 ON ka1.id = al.source_id
         JOIN knowledge_artifacts ka2 ON ka2.id = al.target_id
         WHERE ka1.deleted_at IS NULL AND ka2.deleted_at IS NULL`
      ),
      pool.query(
        `SELECT DISTINCT a1.artifact_id AS artifact_id_1, a2.artifact_id AS artifact_id_2
         FROM knowledge_artifact_sources a1
         JOIN knowledge_artifact_sources a2 ON a1.entry_uuid = a2.entry_uuid
         JOIN knowledge_artifacts ka1 ON ka1.id = a1.artifact_id
         JOIN knowledge_artifacts ka2 ON ka2.id = a2.artifact_id
         WHERE a1.artifact_id < a2.artifact_id
           AND ka1.deleted_at IS NULL AND ka2.deleted_at IS NULL`
      ),
      pool.query(
        `SELECT
           a1.id AS id_1,
           a2.id AS id_2,
           1 - (a1.embedding <=> a2.embedding) AS similarity
         FROM knowledge_artifacts a1
         CROSS JOIN knowledge_artifacts a2
         WHERE a1.id < a2.id
           AND a1.embedding IS NOT NULL
           AND a2.embedding IS NOT NULL
           AND a1.deleted_at IS NULL
           AND a2.deleted_at IS NULL
           AND 1 - (a1.embedding <=> a2.embedding) > 0.3`
      ),
    ]);

  const artifactIds = artifactResult.rows.map((row) => row.id as string);
  const tagsMap = await getArtifactTagsMap(pool, artifactIds);

  return {
    artifacts: artifactResult.rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      kind: row.kind as ArtifactKind,
      /* v8 ignore next */
      tags: tagsMap.get(row.id as string) ?? [],
      has_embedding: row.has_embedding as boolean,
    })),
    explicitLinks: explicitResult.rows.map((row) => ({
      source_id: row.source_id as string,
      target_id: row.target_id as string,
    })),
    sharedSources: sharedSourceResult.rows.map((row) => ({
      artifact_id_1: row.artifact_id_1 as string,
      artifact_id_2: row.artifact_id_2 as string,
    })),
    similarities: similarityResult.rows.map((row) => ({
      id_1: row.id_1 as string,
      id_2: row.id_2 as string,
      similarity: parseFloat(String(row.similarity)),
    })),
  };
}
