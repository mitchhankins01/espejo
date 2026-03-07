import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { getArtifactById } from "../db/queries.js";
import { toArtifactResult } from "../formatters/artifact.js";

export async function handleGetArtifact(
  pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_artifact", input);

  const artifact = await getArtifactById(pool, params.id);

  if (!artifact) {
    return `No artifact found with ID "${params.id}". Check that the ID is correct.`;
  }

  return JSON.stringify(toArtifactResult(artifact), null, 2);
}
