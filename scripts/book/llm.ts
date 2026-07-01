/**
 * Single integration point between the book pipeline and the shared LLM
 * wrapper (`src/llm/chat.ts`). Every tomo LLM call goes through `bookChat` —
 * the pipeline no longer constructs raw `new Anthropic()` clients per module.
 *
 * What this centralizes:
 *   - model tiering (caller passes the model id; mechanical calls use Haiku)
 *   - ephemeral system-prompt caching (on by default — large static prompts
 *     like the writer's are re-sent on the extend retry and across a batch)
 *   - the streaming token-rate progress line (formerly stream-progress.ts),
 *     printed only for the long calls (writer, bilingual) via `progress: true`
 */
import type { ModelMessage } from "ai";
import { chat, type LlmProvider } from "../../src/llm/index.js";
import { config } from "../../src/config.js";

const CHARS_PER_TOK = 4;
const TOK_INTERVAL = 500;
const CHARS_INTERVAL = TOK_INTERVAL * CHARS_PER_TOK;

/**
 * Provider for the book pipeline's mechanical calls — verify, bilingual
 * interleave, current-state, condense. Default "deepseek": the Anthropic
 * balance is no longer assumed available, and DeepSeek (deepseek-v4-pro) is the
 * cost-effective default that keeps these calls running. Override with
 * BOOK_LLM_PROVIDER=anthropic (Claude, highest quality) or =openai (GPT).
 *
 * This does NOT change who authors candidates — the planner/writer author legs
 * are pinned per-leg in models.ts (PLANNER_LEGS). It only routes the model id
 * the book modules pass through bookChat: config.models.bookWriter for the
 * writer/planner/verify tier, config.models.anthropicFast for mechanical calls.
 */
const BOOK_PROVIDER: LlmProvider = ((): LlmProvider => {
  switch (process.env.BOOK_LLM_PROVIDER?.toLowerCase()) {
    case "openai":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "deepseek":
      return "deepseek";
    default:
      return "deepseek";
  }
})();
const OPENAI_WRITER_MODEL = process.env.OPENAI_BOOK_MODEL || "gpt-5.5";
const OPENAI_FAST_MODEL = process.env.OPENAI_BOOK_FAST_MODEL || "gpt-5-mini";
const DEEPSEEK_BOOK_MODEL = process.env.DEEPSEEK_BOOK_MODEL || "deepseek-v4-pro";

/**
 * Resolve the (provider, model) pair for a given anthropic-tier model id.
 * On the anthropic path this is a pass-through. On the deepseek path both tiers
 * collapse to the single DeepSeek model (no cheap mini tier). On the openai
 * path the incoming claude model id is translated to the matching OpenAI tier —
 * the fast tier (anthropicFast) maps to the mini model, everything else (the
 * writer/planner/verify tier) maps to the writer model.
 */
function resolveModel(model: string): { provider: LlmProvider; model: string } {
  if (BOOK_PROVIDER === "anthropic") return { provider: "anthropic", model };
  if (BOOK_PROVIDER === "deepseek") {
    return { provider: "deepseek", model: DEEPSEEK_BOOK_MODEL };
  }
  const isFast = model === config.models.anthropicFast;
  return {
    provider: "openai",
    model: isFast ? OPENAI_FAST_MODEL : OPENAI_WRITER_MODEL,
  };
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

export interface BookChatParams {
  /** Model id — e.g. config.models.bookWriter (writer/planner) or anthropicFast (mechanical). */
  model: string;
  /**
   * Explicit provider override. When set, the (provider, model) pair is used
   * verbatim and the BOOK_LLM_PROVIDER tier-mapping is bypassed — this is how
   * the model-comparison planner/writer target a specific author leg
   * (deepseek/anthropic/openai) regardless of the global route.
   */
  provider?: LlmProvider;
  system: string;
  messages: ModelMessage[];
  maxTokens: number;
  /** 0 for deterministic classifiers (sensitivity); omit otherwise. */
  temperature?: number;
  /**
   * gpt-5 family output-length dial (low|medium|high). Applied ONLY on the
   * openai provider — it's the first-class length control (gpt-5.5 defaults to
   * ~high and runs long; the right level tracks the writer's TARGET_WORDS).
   * DeepSeek reaches the same SDK but doesn't honor it, so it's scoped to openai.
   */
  verbosity?: "low" | "medium" | "high";
  /** Ephemeral system caching. Default true (no-op below the provider's cache minimum). */
  cacheSystem?: boolean;
  /** Label for the progress/done log line. */
  label: string;
  /** Print the streaming token-rate progress line. Default false (long calls only). */
  progress?: boolean;
}

export interface BookChatResult {
  text: string;
  /** Provider finish reason — "stop"/"end_turn" = complete, "length" = hit maxTokens (truncated). */
  finishReason: string;
  outputTokens: number;
}

/**
 * Run one non-tool generation through the shared wrapper; return text +
 * metadata. `finishReason` lets callers detect truncation (a book cut off at
 * the token ceiling otherwise passes a naive word-count check, then ships
 * mid-sentence to the Kindle).
 */
export async function bookChatMeta(p: BookChatParams): Promise<BookChatResult> {
  const start = Date.now();
  let reported = 0;

  const { provider, model } = p.provider
    ? { provider: p.provider, model: p.model }
    : resolveModel(p.model);
  // GPT-5 and DeepSeek reasoning models reject any non-default temperature, so
  // drop it on every non-anthropic path (the only callers that set it —
  // sensitivity and current-state — want determinism, not a specific value;
  // default temp is acceptable for those one-offs).
  const temperature = provider === "anthropic" ? p.temperature : undefined;
  // textVerbosity is an OpenAI-only output-length control. Scope it to the
  // openai provider so it never reaches DeepSeek (same SDK, rejects the param).
  const providerOptions =
    provider === "openai" && p.verbosity
      ? { openai: { textVerbosity: p.verbosity } }
      : undefined;

  const res = await chat({
    provider,
    model,
    system: p.system,
    messages: p.messages,
    maxTokens: p.maxTokens,
    temperature,
    providerOptions,
    cacheSystem: p.cacheSystem ?? true,
    onTextDelta: p.progress
      ? (snapshot: string): void => {
          const chars = snapshot.length;
          while (chars - reported >= CHARS_INTERVAL) {
            reported += CHARS_INTERVAL;
            console.log(
              `      [${p.label}] +${TOK_INTERVAL} tok (~${Math.round(chars / CHARS_PER_TOK)} total, ${formatElapsed(Date.now() - start)} elapsed)`
            );
          }
        }
      : undefined,
  });

  const tok = res.usage.outputTokens ?? Math.round(res.text.length / CHARS_PER_TOK);
  console.log(
    `      [${p.label}] done — ${tok} output tok, ${res.finishReason}, ${formatElapsed(Date.now() - start)}`
  );
  return { text: res.text, finishReason: res.finishReason, outputTokens: tok };
}

/** Convenience wrapper: run one generation and return only its text. */
export async function bookChat(p: BookChatParams): Promise<string> {
  return (await bookChatMeta(p)).text;
}
