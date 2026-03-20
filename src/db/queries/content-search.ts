import type pg from "pg";

import type { ArtifactKind } from "./artifacts.js";
import { normalizeTags } from "./artifacts.js";

// ============================================================================
// Unified search types
// ============================================================================

export interface UnifiedSearchResultRow {
  content_type: "journal_entry" | "knowledge_artifact";
  id: string;
  title_or_label: string;
  snippet: string;
  rrf_score: number;
  match_sources: ("semantic" | "fulltext")[];
}

// ============================================================================
// Query functions
// ============================================================================

export async function searchContent(
  pool: pg.Pool,
  queryEmbedding: number[],
  queryText: string,
  filters: {
    content_types?: ("journal_entry" | "knowledge_artifact")[];
    date_from?: string;
    date_to?: string;
    city?: string;
    entry_tags?: string[];
    artifact_kind?: ArtifactKind;
    artifact_source?: string;
    artifact_tags?: string[];
  },
  limit: number
): Promise<UnifiedSearchResultRow[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const contentTypes = filters.content_types ?? ["journal_entry", "knowledge_artifact"];
  const includeEntries = contentTypes.includes("journal_entry");
  const includeArtifacts = contentTypes.includes("knowledge_artifact");

  const allResults: UnifiedSearchResultRow[] = [];

  if (includeEntries) {
    // Build entry filter clauses
    const entryClauses: string[] = [];
    const entryParams: unknown[] = [];
    let entryIdx = 3;

    if (filters.date_from) {
      entryIdx++;
      entryClauses.push(`e.created_at >= $${entryIdx}::timestamptz`);
      entryParams.push(filters.date_from);
    }
    if (filters.date_to) {
      entryIdx++;
      entryClauses.push(`e.created_at < ($${entryIdx}::date + interval '1 day')`);
      entryParams.push(filters.date_to);
    }
    if (filters.city) {
      entryIdx++;
      entryClauses.push(`e.city ILIKE $${entryIdx}`);
      entryParams.push(filters.city);
    }
    if (filters.entry_tags && filters.entry_tags.length > 0) {
      entryIdx++;
      entryClauses.push(
        `EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id AND t.name = ANY($${entryIdx}::text[]))`
      );
      entryParams.push(filters.entry_tags);
    }
    const entryFilterWhere = entryClauses.length > 0 ? "AND " + entryClauses.join(" AND ") : "";

    const entrySql = `
      WITH params AS (
        SELECT $1::vector AS query_embedding, plainto_tsquery('english', $2) AS ts_query
      ),
      semantic AS (
        SELECT e.id,
               ROW_NUMBER() OVER (ORDER BY e.embedding <=> p.query_embedding) AS rank_s
        FROM entries e, params p
        WHERE e.embedding IS NOT NULL
        ${entryFilterWhere}
        ORDER BY e.embedding <=> p.query_embedding
        LIMIT 20
      ),
      fulltext AS (
        SELECT e.id,
               ROW_NUMBER() OVER (ORDER BY ts_rank(e.text_search, p.ts_query) DESC) AS rank_f
        FROM entries e, params p
        WHERE e.text_search @@ p.ts_query
        ${entryFilterWhere}
        LIMIT 20
      )
      SELECT
        'journal_entry' AS content_type,
        e.uuid AS id,
        COALESCE(e.city, to_char(e.created_at, 'YYYY-MM-DD')) AS title_or_label,
        LEFT(COALESCE(e.text, ''), 200) AS snippet,
        COALESCE(1.0 / (60 + s.rank_s), 0) + COALESCE(1.0 / (60 + f.rank_f), 0) AS rrf_score,
        s.id IS NOT NULL AS has_semantic,
        f.id IS NOT NULL AS has_fulltext
      FROM entries e
      LEFT JOIN semantic s ON e.id = s.id
      LEFT JOIN fulltext f ON e.id = f.id
      WHERE s.id IS NOT NULL OR f.id IS NOT NULL
      ORDER BY rrf_score DESC
      LIMIT $3
    `;

    const entryResult = await pool.query(entrySql, [embeddingStr, queryText, limit, ...entryParams]);
    for (const row of entryResult.rows) {
      const matchSources: ("semantic" | "fulltext")[] = [];
      if (row.has_semantic) matchSources.push("semantic");
      if (row.has_fulltext) matchSources.push("fulltext");
      allResults.push({
        content_type: "journal_entry",
        id: row.id as string,
        title_or_label: row.title_or_label as string,
        snippet: row.snippet as string,
        rrf_score: parseFloat(row.rrf_score as string),
        match_sources: matchSources,
      });
    }
  }

  if (includeArtifacts) {
    // Build artifact filter clauses
    const artClauses: string[] = [];
    const artParams: unknown[] = [];
    let artIdx = 3;

    if (filters.artifact_kind) {
      artIdx++;
      artClauses.push(`a.kind = $${artIdx}`);
      artParams.push(filters.artifact_kind);
    }
    if (filters.artifact_source) {
      artIdx++;
      artClauses.push(`a.source = $${artIdx}`);
      artParams.push(filters.artifact_source);
    }
    if (filters.artifact_tags && filters.artifact_tags.length > 0) {
      artIdx++;
      artClauses.push(
        `EXISTS (SELECT 1 FROM artifact_tags at2 JOIN tags t ON t.id = at2.tag_id WHERE at2.artifact_id = a.id AND t.name = ANY($${artIdx}::text[]))`
      );
      artParams.push(normalizeTags(filters.artifact_tags));
    }
    const artFilterWhere = artClauses.length > 0 ? "AND " + artClauses.join(" AND ") : "";

    const artSql = `
      WITH params AS (
        SELECT $1::vector AS query_embedding, plainto_tsquery('english', $2) AS ts_query
      ),
      semantic AS (
        SELECT a.id,
               ROW_NUMBER() OVER (ORDER BY a.embedding <=> p.query_embedding) AS rank_s
        FROM knowledge_artifacts a, params p
        WHERE a.embedding IS NOT NULL
          AND a.deleted_at IS NULL
          AND a.status = 'approved'
        ${artFilterWhere}
        ORDER BY a.embedding <=> p.query_embedding
        LIMIT 20
      ),
      fulltext AS (
        SELECT a.id,
               ROW_NUMBER() OVER (ORDER BY ts_rank(a.tsv, p.ts_query) DESC) AS rank_f
        FROM knowledge_artifacts a, params p
        WHERE a.tsv @@ p.ts_query
          AND a.deleted_at IS NULL
          AND a.status = 'approved'
        ${artFilterWhere}
        LIMIT 20
      )
      SELECT
        'knowledge_artifact' AS content_type,
        a.id::text AS id,
        a.title AS title_or_label,
        LEFT(a.body, 200) AS snippet,
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

    const artResult = await pool.query(artSql, [embeddingStr, queryText, limit, ...artParams]);
    for (const row of artResult.rows) {
      const matchSources: ("semantic" | "fulltext")[] = [];
      if (row.has_semantic) matchSources.push("semantic");
      if (row.has_fulltext) matchSources.push("fulltext");
      allResults.push({
        content_type: "knowledge_artifact",
        id: row.id as string,
        title_or_label: row.title_or_label as string,
        snippet: row.snippet as string,
        rrf_score: parseFloat(row.rrf_score as string),
        match_sources: matchSources,
      });
    }
  }

  // Merge and sort by RRF score, limit
  allResults.sort((a, b) => b.rrf_score - a.rrf_score);
  return allResults.slice(0, limit);
}
