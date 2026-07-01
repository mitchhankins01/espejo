import type { LlmProvider } from "../../src/llm/index.js";
import { config } from "../../src/config.js";

export interface BookLeg {
  provider: LlmProvider;
  model: string;
  /** Human display name — shown on the plan menu and stamped on the EPUB first page. */
  label: string;
  /**
   * Soft legs are skipped (with a warning) when their provider is unavailable at
   * preflight, instead of aborting the whole run. Use for newer/experimental
   * providers so a flaky dependency can't block the proven core legs.
   */
  soft?: boolean;
}

/**
 * The three author legs for the model-comparison planner. Each leg produces
 * `CANDIDATES_PER_LEG` of the 6 menu candidates, and a `--pick`'d candidate is
 * WRITTEN by its originating leg so finished tomos can be compared per model.
 *
 * Model ids are centralized here. The dedup council keeps its own copy in
 * `scripts/dedup/council-models.json` because it runs as plain `.mjs` and can't
 * import this TS — if a flagship id changes, update both (see the
 * council-config-consolidation note in memory).
 */
export const PLANNER_LEGS: BookLeg[] = [
  {
    provider: "deepseek",
    model: process.env.DEEPSEEK_BOOK_MODEL || "deepseek-v4-pro",
    label: "DeepSeek",
  },
  {
    provider: "anthropic",
    model: config.models.bookWriter,
    label: "Claude",
    // TEMP 2026-06-29: Anthropic key out of credits; soft so the run skips this
    // leg instead of aborting. Revert to a hard leg once topped up.
    soft: true,
  },
  {
    provider: "openai",
    model: process.env.OPENAI_BOOK_MODEL || "gpt-5.5",
    label: "GPT",
  },
  {
    // GLM-5.2 via OpenRouter (OpenAI-compatible). Soft leg: a newcomer on a 4th
    // provider, so a GLM/OpenRouter outage skips it rather than aborting the run.
    // No textVerbosity dial (not OpenAI) → length is prompt + condense-loop only.
    provider: "openrouter",
    model: process.env.OPENROUTER_BOOK_MODEL || "z-ai/glm-5.2",
    label: "GLM",
    soft: true,
  },
];

export const CANDIDATES_PER_LEG = 2;

/** A human-readable "who wrote this" string, e.g. "DeepSeek (deepseek-v4-pro)". */
export function legByline(leg: { label: string; model: string }): string {
  return `${leg.label} (${leg.model})`;
}
