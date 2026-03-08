import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import {
  findSimilarPatternPairs,
  getPatternStats,
  getStalePatterns,
} from "../db/queries.js";
import { runMemoryConsolidation } from "../memory/consolidation.js";

export async function handleReflect(pool: pg.Pool, input: unknown): Promise<string> {
  const params = validateToolInput("reflect", input);

  if (params.action === "stats") {
    const stats = await getPatternStats(pool, params.kind);
    return JSON.stringify(stats, null, 2);
  }

  if (params.action === "review_stale") {
    const stale = await getStalePatterns(pool, 90, params.kind, 20);
    if (stale.length === 0) {
      return "No stale patterns found (90+ days unseen).";
    }
    return JSON.stringify(stale, null, 2);
  }

  const preview = await findSimilarPatternPairs(pool, 0.78, params.kind, 20);
  const consolidation = await runMemoryConsolidation(pool, {
    kind: params.kind,
    maxPairs: 20,
    minSimilarity: 0.78,
    deprecateStale: false,
  });

  return JSON.stringify(
    {
      preview_pairs: preview,
      consolidation,
    },
    null,
    2
  );
}
