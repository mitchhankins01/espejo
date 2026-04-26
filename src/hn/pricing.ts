/**
 * Per-million-token pricing for models we use in HN distillation.
 *
 * Source of truth: https://platform.claude.com/docs/en/about-claude/pricing
 * Verified against the docs on 2026-04-26 — re-check if the model id changes.
 * MEMORY.md flags this as a recurring item to verify on every model bump.
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

export function computeCost(
  model: string,
  usage: TokenUsage
): CostBreakdown {
  const rates = MODEL_PRICING[model];
  if (!rates) {
    throw new Error(
      `No pricing configured for model "${model}". Add it to MODEL_PRICING in src/hn/pricing.ts after verifying rates.`
    );
  }
  const inputCostUsd = (usage.inputTokens / 1_000_000) * rates.inputPerMTok;
  const outputCostUsd =
    (usage.outputTokens / 1_000_000) * rates.outputPerMTok;
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}

/** Format a USD amount like "$0.0234" with 4-decimal precision (small bills). */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
