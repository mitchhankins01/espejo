import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { listArtifacts } from "../db/queries.js";
import { toArtifactResult } from "../formatters/artifact.js";

export async function handleListArtifacts(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("list_artifacts", input);

  const rows = await listArtifacts(pool, {
    kind: params.kind,
    source: params.source,
    tags: params.tags,
    tags_mode: params.tags_mode,
    limit: params.limit,
    offset: params.offset,
  });

  if (rows.length === 0) {
    return "No artifacts found. Try adjusting your filters.";
  }

  return JSON.stringify(rows.map(toArtifactResult), null, 2);
}
