import type {
  ArtifactRow,
  ArtifactSearchResultRow,
  UnifiedSearchResultRow,
} from "../db/queries.js";
import type {
  ArtifactResult,
  ArtifactSearchResult,
  UnifiedSearchResult,
} from "../../specs/tools.spec.js";

export function toArtifactResult(row: ArtifactRow): ArtifactResult {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    has_embedding: row.has_embedding,
    source_entry_uuids: row.source_entry_uuids,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function toArtifactSearchResult(
  row: ArtifactSearchResultRow
): ArtifactSearchResult {
  const match_sources: ("semantic" | "fulltext")[] = [];
  if (row.has_semantic) match_sources.push("semantic");
  if (row.has_fulltext) match_sources.push("fulltext");

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    has_embedding: row.has_embedding,
    rrf_score: row.rrf_score,
    match_sources,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function toUnifiedSearchResult(
  row: UnifiedSearchResultRow
): UnifiedSearchResult {
  return {
    content_type: row.content_type,
    id: row.id,
    title_or_label: row.title_or_label,
    snippet: row.snippet,
    rrf_score: row.rrf_score,
    match_sources: row.match_sources,
  };
}
