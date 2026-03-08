import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { rememberPattern } from "../memory/extraction.js";

export async function handleRemember(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("remember", input);

  const result = await rememberPattern(pool, {
    content: params.content,
    kind: params.kind,
    confidence: params.confidence ?? 0.8,
    evidence: params.evidence,
    entryUuids: params.entry_uuids,
    temporal: params.temporal,
    sourceType: "mcp_explicit",
    sourceId: "remember",
  });

  return JSON.stringify(
    {
      status: result.action,
      pattern_id: result.patternId,
      similarity: result.similarity ?? null,
    },
    null,
    2
  );
}
