/* v8 ignore file */
import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import OpenAI from "openai";
import type pg from "pg";
import { z } from "zod";
import { config } from "../config.js";
import { generateEmbeddingWithUsage } from "../db/embeddings.js";
import {
  findSimilarPatterns,
  insertPattern,
  insertPatternAlias,
  insertPatternObservation,
  linkPatternToEntry,
  logApiUsage,
  reinforcePattern,
} from "../db/queries.js";

export const memoryKindSchema = z.enum(["identity", "preference", "goal"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export interface RememberInput {
  content: string;
  kind: MemoryKind;
  confidence: number;
  evidence?: string;
  entryUuids?: string[];
  temporal?: { date?: string; relevance?: "upcoming" | "ongoing" };
  sourceType: string;
  sourceId?: string;
}

export interface RememberResult {
  action: "inserted" | "reinforced";
  patternId: number;
  similarity?: number;
}

export interface ExtractedPattern {
  content: string;
  kind: MemoryKind;
  confidence: number;
  evidence: string;
  signal: "explicit" | "implicit";
  entry_uuids: string[];
  temporal?: { date?: string; relevance?: "upcoming" | "ongoing" };
}

const saveChatExtractionSchema = z.object({
  patterns: z
    .array(
      z.object({
        content: z.string().min(10).max(200),
        kind: memoryKindSchema,
        confidence: z.number().min(0.4).max(1),
        evidence: z.string().min(8),
        signal: z.enum(["explicit", "implicit"]),
        entry_uuids: z.array(z.string()).optional().default([]),
        temporal: z
          .object({
            date: z.string().optional(),
            relevance: z.enum(["upcoming", "ongoing"]).optional(),
          })
          .optional(),
      })
    )
    .max(5),
});

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

function getLlmProvider(): "anthropic" | "openai" {
  return config.telegram.llmProvider === "openai" ? "openai" : "anthropic";
}

function getLlmModel(provider: "anthropic" | "openai"): string {
  return provider === "openai" ? config.openai.chatModel : config.anthropic.model;
}

function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function computeCanonicalHash(content: string): string {
  return crypto.createHash("sha256").update(normalizeContent(content)).digest("hex");
}

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = config.apiRates[model];
  if (!rates) return 0;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

async function logEmbeddingUsage(pool: pg.Pool, inputTokens: number, latencyMs: number): Promise<void> {
  await logApiUsage(pool, {
    provider: "openai",
    model: config.openai.embeddingModel,
    purpose: "embedding",
    inputTokens,
    outputTokens: 0,
    costUsd: computeCost(config.openai.embeddingModel, inputTokens, 0),
    latencyMs,
  });
}

export async function rememberPattern(
  pool: pg.Pool,
  input: RememberInput
): Promise<RememberResult> {
  const normalizedContent = input.content.trim();
  const hash = computeCanonicalHash(normalizedContent);

  const exact = await pool.query<{ id: number }>(
    `SELECT id
     FROM patterns
     WHERE canonical_hash = $1
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [hash]
  );

  if (exact.rows.length > 0) {
    const row = await reinforcePattern(pool, exact.rows[0].id, input.confidence);
    await insertPatternObservation(pool, {
      patternId: row.id,
      chatMessageIds: [],
      evidence: input.evidence ?? "explicit remember call",
      evidenceRoles: [],
      confidence: input.confidence,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
    });
    for (const uuid of input.entryUuids ?? []) {
      await linkPatternToEntry(pool, row.id, uuid, input.sourceType, input.confidence);
    }
    return { action: "reinforced", patternId: row.id, similarity: 1 };
  }

  const embedStart = Date.now();
  const embeddingResult = await generateEmbeddingWithUsage(normalizedContent);
  const embedding = embeddingResult.embedding;
  await logEmbeddingUsage(pool, embeddingResult.inputTokens, Date.now() - embedStart);

  const similar = await findSimilarPatterns(pool, embedding, 1, 0.8);
  const best = similar[0];

  if (best) {
    const row = await reinforcePattern(pool, best.id, input.confidence);
    await insertPatternAlias(pool, best.id, normalizedContent, embedding);
    await insertPatternObservation(pool, {
      patternId: row.id,
      chatMessageIds: [],
      evidence: input.evidence ?? "semantic dedup reinforcement",
      evidenceRoles: [],
      confidence: input.confidence,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
    });
    for (const uuid of input.entryUuids ?? []) {
      await linkPatternToEntry(pool, row.id, uuid, input.sourceType, input.confidence);
    }
    return {
      action: "reinforced",
      patternId: row.id,
      similarity: best.similarity,
    };
  }

  const created = await insertPattern(pool, {
    content: normalizedContent,
    kind: input.kind,
    confidence: input.confidence,
    embedding,
    temporal: input.temporal ?? null,
    canonicalHash: hash,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    expiresAt: null,
    timestamp: new Date(),
  });

  await insertPatternObservation(pool, {
    patternId: created.id,
    chatMessageIds: [],
    evidence: input.evidence ?? "explicit remember call",
    evidenceRoles: [],
    confidence: input.confidence,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
  });

  for (const uuid of input.entryUuids ?? []) {
    await linkPatternToEntry(pool, created.id, uuid, input.sourceType, input.confidence);
  }

  return { action: "inserted", patternId: created.id };
}

export async function extractPatternsFromChat(
  pool: pg.Pool,
  params: { messages: string; context?: string }
): Promise<ExtractedPattern[]> {
  const prompt = `Extract durable memory patterns from this transcript.

Kinds allowed:
- identity: durable biographical facts
- preference: recurring preferences, values, habits
- goal: active intentions

Hard filters:
- No biometric dumps unless they imply durable identity/preference/goal
- No hypotheticals or assistant suggestions
- Keep 10-200 chars per content
- confidence must be >= 0.4
- implicit signals should only be included when high confidence (>= 0.6)
- max 5 patterns

Return strict JSON with key "patterns" only.

Context hint: ${params.context ?? "none"}

Transcript:
<untrusted>
${params.messages}
</untrusted>`;

  const provider = getLlmProvider();
  const model = getLlmModel(provider);
  const apiStartMs = Date.now();
  let responseText: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  if (provider === "openai") {
    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      model,
      max_tokens: 1400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: prompt },
      ],
    });
    responseText = response.choices[0]?.message?.content ?? null;
    inputTokens = response.usage?.prompt_tokens ?? 0;
    outputTokens = response.usage?.completion_tokens ?? 0;
  } else {
    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1400,
      messages: [{ role: "user", content: prompt }],
    });
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    responseText = textBlock?.text ?? null;
    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;
  }

  await logApiUsage(pool, {
    provider,
    model,
    purpose: "save_chat_extraction",
    inputTokens,
    outputTokens,
    costUsd: computeCost(model, inputTokens, outputTokens),
    latencyMs: Date.now() - apiStartMs,
  });

  if (!responseText) return [];

  let jsonText = responseText;
  const wrapped = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (wrapped) {
    jsonText = wrapped[1] ?? "";
  }

  const parsed = saveChatExtractionSchema.parse(JSON.parse(jsonText));
  return parsed.patterns.filter((pattern) => {
    if (pattern.signal === "implicit" && pattern.confidence < 0.6) {
      return false;
    }
    return true;
  });
}
