import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { searchEntries } from "../db/queries.js";
import { generateEmbedding } from "../db/embeddings.js";
import { toSearchResult } from "../formatters/mappers.js";

export async function handleSearchEntries(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("search_entries", input);

  const embedding = await generateEmbedding(params.query);

  const rows = await searchEntries(
    pool,
    embedding,
    params.query,
    {
      date_from: params.date_from,
      date_to: params.date_to,
      tags: params.tags,
      city: params.city,
    },
    params.limit
  );

  if (rows.length === 0) {
    return "No results found. Try broadening your search query or adjusting filters.";
  }

  return JSON.stringify(rows.map(toSearchResult), null, 2);
}
