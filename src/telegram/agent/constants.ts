import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "../../config.js";

// ---------------------------------------------------------------------------
// LLM clients (lazy singletons)
// ---------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;

export function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

export function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

export function getLlmProvider(): "anthropic" | "openai" {
  return config.telegram.llmProvider === "openai" ? "openai" : "anthropic";
}

export function getLlmModel(provider: "anthropic" | "openai"): string {
  return provider === "openai" ? config.openai.chatModel : config.anthropic.model;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_TOOL_CALLS = 15;
export const WALL_CLOCK_TIMEOUT_MS = 120_000;
export const CHARS_PER_TOKEN = 4;
export const TOOL_RESULT_MAX_CHARS = 500;
export const SEARCH_RESULT_ENTRY_MAX_CHARS = 100;
export const COMPACTION_TOKEN_BUDGET = 12_000;
export const MIN_MESSAGES_FOR_FORCE_COMPACT = 4;
export const RECENT_MESSAGES_LIMIT = 50;

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
