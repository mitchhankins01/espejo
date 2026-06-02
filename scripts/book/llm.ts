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
import { chat } from "../../src/llm/index.js";

const CHARS_PER_TOK = 4;
const TOK_INTERVAL = 500;
const CHARS_INTERVAL = TOK_INTERVAL * CHARS_PER_TOK;

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

export interface BookChatParams {
  /** Model id — e.g. config.models.bookWriter (writer/planner) or anthropicFast (mechanical). */
  model: string;
  system: string;
  messages: ModelMessage[];
  maxTokens: number;
  /** 0 for deterministic classifiers (sensitivity); omit otherwise. */
  temperature?: number;
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

  const res = await chat({
    provider: "anthropic",
    model: p.model,
    system: p.system,
    messages: p.messages,
    maxTokens: p.maxTokens,
    temperature: p.temperature,
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
