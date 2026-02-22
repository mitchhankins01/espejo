import OpenAI from "openai";
import { config } from "../config.js";

let client: OpenAI | null = null;

export interface EmbeddingUsage {
  inputTokens: number;
}

export interface EmbeddingResultWithUsage extends EmbeddingUsage {
  embedding: number[];
}

export interface EmbeddingsBatchResultWithUsage extends EmbeddingUsage {
  embeddings: number[][];
}

function getClient(): OpenAI {
  if (!client) {
    if (!config.openai.apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for embedding generation. Set it in your environment."
      );
    }
    client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return client;
}

/**
 * Generate a single embedding vector with usage metadata.
 */
export async function generateEmbeddingWithUsage(
  text: string
): Promise<EmbeddingResultWithUsage> {
  const openai = getClient();
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
    dimensions: config.openai.embeddingDimensions,
  });

  return {
    embedding: response.data[0].embedding,
    inputTokens: response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0,
  };
}

/**
 * Generate a single embedding vector for a text string.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const result = await generateEmbeddingWithUsage(text);
  return result.embedding;
}

/**
 * Generate embeddings for a batch of texts with usage metadata.
 * Returns embedding vectors in the same order as the input.
 */
export async function generateEmbeddingsBatchWithUsage(
  texts: string[]
): Promise<EmbeddingsBatchResultWithUsage> {
  if (texts.length === 0) {
    return { embeddings: [], inputTokens: 0 };
  }

  const openai = getClient();
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: texts,
    dimensions: config.openai.embeddingDimensions,
  });

  // Sort by index to ensure order matches input
  const sorted = response.data.sort((a, b) => a.index - b.index);
  return {
    embeddings: sorted.map((d) => d.embedding),
    inputTokens: response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0,
  };
}

/**
 * Generate embeddings for a batch of texts.
 * Returns an array of embedding vectors in the same order as the input.
 */
export async function generateEmbeddingsBatch(
  texts: string[]
): Promise<number[][]> {
  const result = await generateEmbeddingsBatchWithUsage(texts);
  return result.embeddings;
}
