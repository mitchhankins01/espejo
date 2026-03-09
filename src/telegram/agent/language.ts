import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import { pool } from "../../db/client.js";
import { generateEmbeddingWithUsage } from "../../db/embeddings.js";
import {
  getLanguagePreferencePatterns,
  logApiUsage,
  searchPatternsHybrid,
  upsertSpanishVocabulary,
  upsertSpanishProgressSnapshot,
  type PatternSearchRow,
} from "../../db/queries.js";
import type { ChatModeState } from "../evening-review.js";
import {
  CHARS_PER_TOKEN,
  LANGUAGE_ANCHOR_LIMIT,
  MIN_RETRIEVAL_CHARS,
  PATTERN_TOKEN_BUDGET,
  RETRIEVAL_BASE_MIN_SIMILARITY,
  RETRIEVAL_SCORE_FLOOR_DEFAULT,
  RETRIEVAL_SCORE_FLOOR_SHORT_QUERY,
  RETRIEVAL_SHORT_QUERY_MIN_SIMILARITY,
  SPANISH_AUTO_LOG_LIMIT,
  SPANISH_STOP_WORDS,
  normalizeContent,
  wordCount,
  getAnthropic,
  getOpenAI,
  getLlmProvider,
  getLlmModel,
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

export function hasSpanishSignals(text: string): boolean {
  return /[áéíóúñ¿¡]|\b(hola|gracias|vamos|pero|porque|hoy|mañana|manana|yo|tu|eres|estoy|para|con)\b/i.test(
    text
  );
}

function hasSingleLanguageOverride(message: string): boolean {
  return /\b(only|just)\s+english\b|\bin\s+english\s+only\b|\bsolo\s+ingles\b|\balleen\s+engels\b/i.test(
    message
  );
}

function todayInTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function inferRegionFromMessage(message: string): string | undefined {
  const text = normalizeContent(message);
  if (text.includes("honduras") || text.includes("hondure")) return "honduras";
  /* v8 ignore next -- optional regional alias */
  if (text.includes("venezuela") || text.includes("venezol")) return "venezuela";
  /* v8 ignore next -- optional regional alias */
  if (text.includes("mexico") || text.includes("mexican")) return "mexico";
  /* v8 ignore next -- optional regional alias */
  if (text.includes("spain") || text.includes("españa") || text.includes("espana")) return "spain";
  /* v8 ignore next -- optional regional alias */
  if (text.includes("colombia")) return "colombia";
  /* v8 ignore next -- optional regional alias */
  if (text.includes("argentina")) return "argentina";
  return undefined;
}

function extractSpanishCandidates(message: string): string[] {
  if (!hasSpanishSignals(message)) return [];

  const tokens = message
    .toLowerCase()
    .match(/[a-záéíóúñü]{3,}/g);
  if (!tokens) return [];

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (SPANISH_STOP_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    candidates.push(token);
    if (candidates.length >= SPANISH_AUTO_LOG_LIMIT) break;
  }

  return candidates;
}

export async function autoLogSpanishVocabulary(
  chatId: string,
  message: string
): Promise<number> {
  const candidates = extractSpanishCandidates(message);
  if (candidates.length === 0) return 0;

  const region = inferRegionFromMessage(message);
  for (const word of candidates) {
    await upsertSpanishVocabulary(pool, {
      chatId,
      word,
      region,
      source: "auto-chat",
    });
  }
  await upsertSpanishProgressSnapshot(pool, chatId, todayInTimezone());
  return candidates.length;
}

function extractRequestedSentenceCount(message: string): number | null {
  const match = message.match(/\b(\d{1,2})\s+sentences?\b/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function shouldRewriteForLanguagePreference(
  _mode: ChatModeState,
  message: string,
  responseText: string,
  patterns: PatternSearchRow[],
  hasSpanishProfile: boolean
): boolean {
  if (hasSingleLanguageOverride(message)) return false;

  const patternsText = patterns
    .map((p) => normalizeContent(p.content))
    .join(" ");
  const hasEnglish = patternsText.includes("english");
  const hasDutch = patternsText.includes("dutch") || patternsText.includes("nederlands");
  const hasSpanish =
    patternsText.includes("spanish") ||
    patternsText.includes("espanol") ||
    patternsText.includes("español");

  const hasLanguageSignal = (hasEnglish && hasDutch && hasSpanish) || hasSpanishProfile;

  if (!hasLanguageSignal) return false;

  // Spanish is primary — rewrite if the response lacks Spanish signals.
  return !hasSpanishSignals(responseText);
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

export async function retrieveLanguagePreferenceAnchors(): Promise<PatternSearchRow[]> {
  try {
    const anchors = await getLanguagePreferencePatterns(pool, LANGUAGE_ANCHOR_LIMIT);
    return anchors.map((pattern, idx) => ({
      ...pattern,
      // Synthetic retrieval metadata so anchors can share the same prompt path.
      score: 1 - idx * 0.001,
      similarity: 1,
    }));
  } catch (err) {
    console.error("Telegram language preference retrieval error:", err);
    return [];
  }
}

export function mergePromptPatterns(
  retrieved: PatternSearchRow[],
  anchors: PatternSearchRow[]
): PatternSearchRow[] {
  const deduped: PatternSearchRow[] = [];
  const seen = new Set<number>();

  for (const pattern of [...anchors, ...retrieved]) {
    if (seen.has(pattern.id)) continue;
    seen.add(pattern.id);
    deduped.push(pattern);
  }

  return budgetCapPatterns(deduped, PATTERN_TOKEN_BUDGET);
}

export async function rewriteWithLanguagePreference(
  message: string,
  responseText: string
): Promise<string> {
  const provider = getLlmProvider();
  const model = getLlmModel(provider);
  const requestedSentenceCount = extractRequestedSentenceCount(message);
  const sentenceRule = requestedSentenceCount
    ? `Use exactly ${requestedSentenceCount} sentences.`
    : "Keep roughly the same sentence count as the draft.";
  const systemPrompt = `Rewrite the assistant draft while preserving meaning and constraints.
- Keep the response concise and natural.
- Spanish is the PRIMARY language — rewrite the bulk of the response in Spanish.
- Weave in English or Dutch only for warmth, humor, or to clarify vocabulary above B1.
- Do not add new factual claims.
- Keep Telegram HTML-compatible text only (no markdown fences).
- ${sentenceRule}
Return only the rewritten response text.`;
  const userPrompt = `User message:
${message}

Draft response:
${responseText}`;

  try {
    const apiStartMs = Date.now();
    let rewritten: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    if (provider === "openai") {
      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model,
        max_tokens: 512,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      rewritten = response.choices[0]?.message?.content ?? null;
      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;
    } else {
      const anthropic = getAnthropic();
      const response = await anthropic.messages.create({
        model,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      rewritten = textBlock?.text ?? null;
      inputTokens = response.usage.input_tokens;
      outputTokens = response.usage.output_tokens;
    }

    await logApiUsage(pool, {
      provider,
      model,
      purpose: "agent",
      inputTokens,
      outputTokens,
      costUsd: computeCost(model, inputTokens, outputTokens),
      latencyMs: Date.now() - apiStartMs,
    });

    const cleaned = rewritten?.trim();
    return cleaned && cleaned.length > 0 ? cleaned : responseText;
  } catch (err) {
    console.error("Telegram language preference rewrite error:", err);
    return responseText;
  }
}
