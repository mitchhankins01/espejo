import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { generateEmbedding } from "../db/embeddings.js";
import { searchPatternsHybrid } from "../db/queries.js";

export async function handleRecall(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("recall", input);
  const embedding = await generateEmbedding(params.query);
  const rows = await searchPatternsHybrid(
    pool,
    embedding,
    params.query,
    Math.min((params.limit ?? 10) * 3, 40),
    0.35
  );

  const filtered = params.kinds?.length
    ? rows.filter((row) =>
        params.kinds?.some((kind) => kind === row.kind)
      )
    : rows;

  const sliced = filtered.slice(0, params.limit ?? 10);

  if (sliced.length === 0) {
    return "No matching memories found.";
  }

  return JSON.stringify(
    sliced.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      confidence: row.confidence,
      times_seen: row.times_seen,
      last_seen: row.last_seen,
      score: row.score,
    })),
    null,
    2
  );
}
