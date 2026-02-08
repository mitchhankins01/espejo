import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { findSimilarEntries } from "../db/queries.js";
import { formatSimilarResults } from "../formatters/search-results.js";

export async function handleFindSimilar(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("find_similar", input);

  const results = await findSimilarEntries(pool, params.uuid, params.limit);

  return formatSimilarResults(results);
}
