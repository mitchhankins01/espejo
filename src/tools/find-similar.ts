import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { findSimilarEntries } from "../db/queries.js";
import { toSimilarResult } from "../formatters/mappers.js";

export async function handleFindSimilar(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("find_similar", input);

  const rows = await findSimilarEntries(pool, params.uuid, params.limit);

  if (rows.length === 0) {
    return "No similar entries found. The source entry may not have an embedding.";
  }

  return JSON.stringify(rows.map(toSimilarResult), null, 2);
}
