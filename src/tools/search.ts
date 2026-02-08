import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { searchEntries } from "../db/queries.js";
import { generateEmbedding } from "../db/embeddings.js";
import { formatSearchResults } from "../formatters/search-results.js";

export async function handleSearchEntries(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("search_entries", input);

  const embedding = await generateEmbedding(params.query);

  const results = await searchEntries(
    pool,
    embedding,
    params.query,
    {
      date_from: params.date_from,
      date_to: params.date_to,
      tags: params.tags,
      city: params.city,
      starred: params.starred,
    },
    params.limit
  );

  return formatSearchResults(results);
}
