/**
 * LLM-as-judge Spanish conversation quality assessment.
 *
 * Samples recent user messages from chat_messages, sends them to an LLM
 * for structured evaluation of Spanish quality, and stores the result
 * in spanish_assessments.
 *
 * Interface-agnostic: callable from Telegram commands, HTTP endpoints,
 * or scheduled jobs.
 */

import type pg from "pg";
import type { ChatMessageRow, SpanishAssessmentRow } from "../db/queries.js";
import { getRecentMessages, insertSpanishAssessment, logApiUsage } from "../db/queries.js";

// ============================================================================
// Types
// ============================================================================

export interface AssessmentResult {
  assessment: SpanishAssessmentRow;
  summary: string;
}

interface LlmAssessmentResponse {
  complexity_score: number;
  grammar_score: number;
  vocabulary_score: number;
  code_switching_ratio: number;
  overall_score: number;
  rationale: string;
}

/** Dependency injection for the LLM call — makes testing easy. */
export interface AssessmentLlmClient {
  assess(systemPrompt: string, userPrompt: string): Promise<{
    result: LlmAssessmentResponse;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

// ============================================================================
// Assessment prompt
// ============================================================================

const ASSESSMENT_SYSTEM_PROMPT = `You are a Spanish language proficiency evaluator. You will be given a sample of messages written by a language learner during Telegram conversations with a Spanish coaching bot.

Evaluate the learner's Spanish proficiency across these dimensions:

1. **complexity_score** (1-5): Sentence structure complexity. 1 = single words/fragments, 3 = simple complete sentences, 5 = complex/compound sentences with subordinate clauses.

2. **grammar_score** (1-5): Grammatical accuracy. 1 = frequent errors in basic structures, 3 = mostly correct with occasional errors, 5 = near-native accuracy including subjunctive, conditionals, etc.

3. **vocabulary_score** (1-5): Vocabulary range and appropriateness. 1 = basic survival vocabulary, 3 = conversational range, 5 = rich/varied including idiomatic expressions.

4. **code_switching_ratio** (0-1): Proportion of text that is in Spanish (vs English/Dutch/other). 1.0 = all Spanish, 0.0 = no Spanish.

5. **overall_score** (1-5): Holistic assessment of Spanish communicative competence.

6. **rationale**: 1-2 sentence explanation of the assessment, noting strengths and areas for improvement.

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{"complexity_score": N, "grammar_score": N, "vocabulary_score": N, "code_switching_ratio": N, "overall_score": N, "rationale": "..."}`;

// ============================================================================
// Core assessment function
// ============================================================================

export async function assessSpanishQuality(
  pool: pg.Pool,
  chatId: string,
  llmClient: AssessmentLlmClient
): Promise<AssessmentResult> {
  // Sample recent user messages (last 50, filter to user role)
  const allMessages = await getRecentMessages(pool, chatId, 50);
  const userMessages = allMessages.filter((m) => m.role === "user");

  if (userMessages.length < 3) {
    throw new Error("Not enough user messages to assess (need at least 3).");
  }

  // Take up to 20 most recent user messages
  const sample = userMessages.slice(-20);
  const userPrompt = formatSampleForAssessment(sample);

  const { result, inputTokens, outputTokens, costUsd } = await llmClient.assess(
    ASSESSMENT_SYSTEM_PROMPT,
    userPrompt
  );

  await logApiUsage(pool, {
    provider: "openai",
    model: "gpt-4o-mini",
    purpose: "assessment",
    inputTokens,
    outputTokens,
    costUsd,
  });

  const assessment = await insertSpanishAssessment(pool, {
    chatId,
    complexityScore: clampScore(result.complexity_score),
    grammarScore: clampScore(result.grammar_score),
    vocabularyScore: clampScore(result.vocabulary_score),
    codeSwitchingRatio: clamp01(result.code_switching_ratio),
    overallScore: clampScore(result.overall_score),
    sampleMessageCount: sample.length,
    rationale: result.rationale || "No rationale provided.",
  });

  const summary = formatAssessmentSummary(assessment);
  return { assessment, summary };
}

// ============================================================================
// Formatting
// ============================================================================

export function formatSampleForAssessment(messages: ChatMessageRow[]): string {
  return messages
    .map((m, i) => `[${i + 1}] ${m.content}`)
    .join("\n\n");
}

export function formatAssessmentSummary(assessment: SpanishAssessmentRow): string {
  const lines = [
    `<b>Spanish Assessment</b> (${assessment.sample_message_count} messages)`,
    "",
    `Overall: <b>${assessment.overall_score.toFixed(1)}/5</b>`,
    `Complexity: ${assessment.complexity_score.toFixed(1)} · Grammar: ${assessment.grammar_score.toFixed(1)} · Vocabulary: ${assessment.vocabulary_score.toFixed(1)}`,
    `Spanish ratio: ${Math.round(assessment.code_switching_ratio * 100)}%`,
    "",
    `<i>${assessment.rationale}</i>`,
  ];
  return lines.join("\n");
}

// ============================================================================
// LLM client factories
// ============================================================================

/**
 * Create an assessment client backed by OpenAI (gpt-4o-mini for cost efficiency).
 * Pass the OpenAI instance to avoid creating a new one.
 */
export function createOpenAIAssessmentClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI SDK overloads don't narrow to a simple structural type
  openai: { chat: { completions: { create: (...args: any[]) => Promise<any> } } }
): AssessmentLlmClient {
  return {
    async assess(systemPrompt: string, userPrompt: string) {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }) as {
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const content = response.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as LlmAssessmentResponse;

      const usage = response.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
      const costUsd =
        (usage.prompt_tokens * 0.15 + usage.completion_tokens * 0.6) / 1_000_000;

      return {
        result: parsed,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        costUsd,
      };
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function clampScore(value: number): number {
  return Math.min(5, Math.max(1, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
