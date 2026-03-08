/* v8 ignore file */
import type pg from "pg";
import {
  enforceActivePatternCap,
  findSimilarPatternPairs,
  getStalePatterns,
  insertPatternAlias,
  insertPatternRelation,
  reinforcePattern,
  updatePatternStatus,
} from "../db/queries.js";

export interface ConsolidationResult {
  consolidated: number;
  stale: number;
  deprecatedForCap: number;
  notes: string[];
}

export async function runMemoryConsolidation(
  pool: pg.Pool,
  params?: {
    kind?: string;
    deprecateStale?: boolean;
    maxPairs?: number;
    minSimilarity?: number;
    activeCap?: number;
  }
): Promise<ConsolidationResult> {
  const minSimilarity = params?.minSimilarity ?? 0.78;
  const maxPairs = params?.maxPairs ?? 20;
  const activeCap = params?.activeCap ?? 40;

  const pairs = await findSimilarPatternPairs(
    pool,
    minSimilarity,
    params?.kind,
    maxPairs
  );

  let consolidated = 0;
  const touched = new Set<number>();

  for (const pair of pairs) {
    if (touched.has(pair.pattern_id_1) || touched.has(pair.pattern_id_2)) {
      continue;
    }

    const keepId = pair.pattern_id_1;
    const supersededId = pair.pattern_id_2;

    await reinforcePattern(pool, keepId, 0.85);
    await insertPatternAlias(pool, keepId, pair.content_2, null);
    await insertPatternRelation(pool, keepId, supersededId, "supersedes");
    await updatePatternStatus(pool, supersededId, "superseded");

    touched.add(keepId);
    touched.add(supersededId);
    consolidated++;
  }

  const stalePatterns = await getStalePatterns(pool, 90, params?.kind, 20);
  if (params?.deprecateStale) {
    for (const pattern of stalePatterns) {
      await updatePatternStatus(pool, pattern.id, "deprecated");
    }
  }

  const deprecatedForCap = await enforceActivePatternCap(pool, activeCap);

  const notes: string[] = [];
  if (consolidated > 0) {
    notes.push(
      `Consolidated ${consolidated} overlapping ${consolidated === 1 ? "pattern" : "patterns"}.`
    );
  }
  if (stalePatterns.length > 0) {
    notes.push(
      `${stalePatterns.length} ${stalePatterns.length === 1 ? "pattern" : "patterns"} not seen in 90+ days.`
    );
  }
  if (deprecatedForCap > 0) {
    notes.push(`Deprecated ${deprecatedForCap} low-priority patterns to enforce active cap.`);
  }

  return {
    consolidated,
    stale: stalePatterns.length,
    deprecatedForCap,
    notes,
  };
}
