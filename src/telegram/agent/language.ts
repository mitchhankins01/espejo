import { config } from "../../config.js";
import { pool } from "../../db/client.js";
import { generateEmbeddingWithUsage } from "../../db/embeddings.js";
import {
  logApiUsage,
  searchPatternsHybrid,
  type PatternSearchRow,
} from "../../db/queries.js";
import {
  CHARS_PER_TOKEN,
  MIN_RETRIEVAL_CHARS,
  PATTERN_TOKEN_BUDGET,
  RETRIEVAL_BASE_MIN_SIMILARITY,
  RETRIEVAL_SCORE_FLOOR_DEFAULT,
  RETRIEVAL_SCORE_FLOOR_SHORT_QUERY,
  RETRIEVAL_SHORT_QUERY_MIN_SIMILARITY,
  normalizeContent,
  wordCount,
} from "./constants.js";
import { computeCost } from "./costs.js";

// ---------------------------------------------------------------------------
// MMR reranking
// ---------------------------------------------------------------------------

function mmrRerank(
  patterns: PatternSearchRow[],
  lambda: number = 0.7
): PatternSearchRow[] {
  /* v8 ignore next -- defensive guard; searchPatterns returns [] before mmrRerank */
  if (patterns.length === 0) return [];

  const selected: PatternSearchRow[] = [];
  const remaining = [...patterns];

  // Select first (highest score)
  selected.push(remaining.shift()!);

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.score;

      // Max similarity to any already-selected pattern
      let maxSim = 0;
      for (const s of selected) {
        const sim = candidate.similarity * s.similarity; // approximate
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

export function budgetCapPatterns(
  patterns: PatternSearchRow[],
  budgetTokens: number
): PatternSearchRow[] {
  const result: PatternSearchRow[] = [];
  let totalChars = 0;
  const maxChars = budgetTokens * CHARS_PER_TOKEN;

  for (const p of patterns) {
    const entryChars = p.content.length + 50; // overhead for formatting
    /* v8 ignore next -- budget cap rarely hit with small pattern sets */
    if (totalChars + entryChars > maxChars) break;
    totalChars += entryChars;
    result.push(p);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Retrieval helpers
// ---------------------------------------------------------------------------

function isLikelyDirectiveWithoutMemoryNeed(message: string): boolean {
  const normalized = normalizeContent(message);
  const words = wordCount(normalized);
  const mentionsMemoryIntent =
    /\b(memory|memories|remember|pattern|patterns|recall)\b/.test(normalized);

  if (/^\/\w+/.test(normalized)) return true;
  if (/^(today i weigh|i weighed|log my weight|record my weight)\b/.test(normalized)) {
    return true;
  }
  if (
    /^(give me (the )?full journal entry|write (the )?entry( now)?|compose (the )?entry|write it up|close (it )?out)\b/.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    !mentionsMemoryIntent &&
    words <= 8 &&
    /^(write|compose|give|show|send|log|track|save|record)\b/.test(normalized)
  ) {
    return true;
  }

  return false;
}

export function shouldRetrievePatterns(message: string): boolean {
  if (message.length < MIN_RETRIEVAL_CHARS) return false;
  if (isLikelyDirectiveWithoutMemoryNeed(message)) return false;
  return true;
}

function minSimilarityForQuery(queryText: string): number {
  return wordCount(queryText) <= 6
    ? RETRIEVAL_SHORT_QUERY_MIN_SIMILARITY
    : RETRIEVAL_BASE_MIN_SIMILARITY;
}

function scoreFloorForQuery(queryText: string): number {
  return wordCount(queryText) <= 6
    ? RETRIEVAL_SCORE_FLOOR_SHORT_QUERY
    : RETRIEVAL_SCORE_FLOOR_DEFAULT;
}

// ---------------------------------------------------------------------------
// Embedding usage logging
// ---------------------------------------------------------------------------

async function logEmbeddingUsage(
  inputTokens: number,
  latencyMs: number
): Promise<void> {
  try {
    await logApiUsage(pool, {
      provider: "openai",
      model: config.openai.embeddingModel,
      purpose: "embedding",
      inputTokens,
      outputTokens: 0,
      costUsd: computeCost(config.openai.embeddingModel, inputTokens, 0),
      latencyMs,
    });
  } catch (err) {
    console.error("Telegram embedding usage logging failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Pattern retrieval
// ---------------------------------------------------------------------------

export async function retrievePatterns(
  queryText: string
): Promise<{ patterns: PatternSearchRow[]; degraded: boolean }> {
  try {
    const embeddingStartMs = Date.now();
    const embeddingResult = await generateEmbeddingWithUsage(queryText);
    await logEmbeddingUsage(
      embeddingResult.inputTokens,
      Date.now() - embeddingStartMs
    );

    const raw = await searchPatternsHybrid(
      pool,
      embeddingResult.embedding,
      queryText,
      20,
      minSimilarityForQuery(queryText)
    );
    const reranked = mmrRerank(raw);
    const scoreFloor = scoreFloorForQuery(queryText);
    const relevant = reranked.filter((p) => p.score >= scoreFloor);
    const capped = budgetCapPatterns(relevant, PATTERN_TOKEN_BUDGET);
    return { patterns: capped, degraded: false };
  } catch (err) {
    console.error("Telegram pattern retrieval error:", err);
    return { patterns: [], degraded: true };
  }
}
