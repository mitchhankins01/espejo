import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { config } from "../config.js";

export interface EmbedResult {
  embedding: number[];
  inputTokens: number;
}

let modelInstance: ReturnType<typeof openai.textEmbeddingModel> | null = null;

function getModel() {
  if (!modelInstance) {
    modelInstance = openai.textEmbeddingModel(config.openai.embeddingModel);
  }
  return modelInstance;
}

export async function embedText(text: string): Promise<EmbedResult> {
  const result = await embed({
    model: getModel(),
    value: text,
    providerOptions: {
      openai: { dimensions: config.openai.embeddingDimensions },
    },
  });
  return {
    embedding: result.embedding,
    inputTokens: result.usage?.tokens ?? 0,
  };
}

export async function embedTextSimple(text: string): Promise<number[]> {
  return (await embedText(text)).embedding;
}
