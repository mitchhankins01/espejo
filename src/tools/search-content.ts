import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { searchContent } from "../db/queries.js";
import { generateEmbedding } from "../db/embeddings.js";
import { toUnifiedSearchResult } from "../formatters/artifact.js";

export async function handleSearchContent(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("search_content", input);

  const embedding = await generateEmbedding(params.query);

  const rows = await searchContent(
    pool,
    embedding,
    params.query,
    {
      content_types: params.content_types,
      date_from: params.date_from,
      date_to: params.date_to,
      city: params.city,
      artifact_kind: params.artifact_kind,
      artifact_source: params.artifact_source,
    },
    params.limit
  );

  if (rows.length === 0) {
    return "No results found. Try broadening your search query or adjusting filters.";
  }

  return JSON.stringify(rows.map(toUnifiedSearchResult), null, 2);
}
