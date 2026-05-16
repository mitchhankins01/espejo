// Last-resort Haiku one-shot when no corpus sentence contains the inflected
// form. Caches into conjugation_reviews.generated_sentence so subsequent
// reviews of the same cell reuse the same sentence without re-calling Haiku.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export interface ClozeGenInput {
  lemma: string;
  tense: string;
  person: string;
  form: string;
}

export interface ClozeGenResult {
  sentence: string;
  form: string;
}

const SYSTEM_PROMPT =
  "You generate one short Spanish sentence that uses a specific conjugated " +
  "verb form. Constraints:\n" +
  "- The sentence must contain the exact form you were given (case- and " +
  "accent-sensitive).\n" +
  "- ≤ 80 characters.\n" +
  "- Natural, everyday register (Spain Spanish).\n" +
  "- Output strict JSON `{\"sentence\": \"…\"}` only. No commentary.";

interface RawGen {
  sentence?: unknown;
}

export async function generateClozeSentence(
  input: ClozeGenInput
): Promise<ClozeGenResult> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY missing — can't generate cloze sentence.");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const userPrompt = JSON.stringify({
    lemma: input.lemma,
    tense: input.tense,
    person: input.person,
    form: input.form,
  });
  const response = await client.messages.create({
    model: config.models.anthropicFast,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  if (!textBlock) {
    throw new Error("Haiku returned no text block");
  }
  const trimmed = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(trimmed) as RawGen;
  if (typeof parsed.sentence !== "string" || parsed.sentence.length === 0) {
    throw new Error("Haiku returned malformed cloze sentence");
  }
  return { sentence: parsed.sentence.trim(), form: input.form };
}
