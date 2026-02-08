import OpenAI from "openai";
import { config } from "../config.js";

let client: OpenAI | null = null;

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
 * Generate a single embedding vector for a text string.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = getClient();
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
    dimensions: config.openai.embeddingDimensions,
  });
  return response.data[0].embedding;
}

/**
 * Generate embeddings for a batch of texts.
 * Returns an array of embedding vectors in the same order as the input.
 */
export async function generateEmbeddingsBatch(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const openai = getClient();
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: texts,
    dimensions: config.openai.embeddingDimensions,
  });

  // Sort by index to ensure order matches input
  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}
