import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { searchArtifacts } from "../db/queries.js";
import { generateEmbedding } from "../db/embeddings.js";
import { toArtifactSearchResult } from "../formatters/artifact.js";

export async function handleSearchArtifacts(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("search_artifacts", input);

  const embedding = await generateEmbedding(params.query);

  const rows = await searchArtifacts(
    pool,
    embedding,
    params.query,
    {
      kind: params.kind,
      source: params.source,
    },
    params.limit
  );

  if (rows.length === 0) {
    return "No artifacts found. Try broadening your search query or adjusting filters.";
  }

  return JSON.stringify(rows.map(toArtifactSearchResult), null, 2);
}
