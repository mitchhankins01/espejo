import { readMarkedBlock, TOMO_PROMPT_PATH } from "./prompt-doc.js";

export async function readOpenQuestions(
  path: string = TOMO_PROMPT_PATH
): Promise<string[]> {
  const block = await readMarkedBlock("OPEN QUESTIONS", path);
  return block
    .split("\n")
    .map((line) => line.replace(/^\s*-\s+/, "").trim())
    .filter((line) => line.length > 0);
}

export function formatOpenQuestionsForWriter(questions: string[]): string {
  if (questions.length === 0) return "";
  const bullets = questions.map((q) => `- ${q}`).join("\n");
  return [
    "# Open Spanish questions",
    'These are grammar/conjugation structures the reader is actively trying to lock in — areas of ambiguity he flagged himself. Every time the tomo exercises any of them, drop an inline italic-English gloss in parens right after the structure, and the gloss must CONTRAST against the form the reader might have wrongly reached for. Gloss every occurrence, not just the first. Glosses are reserved for these structures only — never for vocabulary, never as callbacks to prior tomos. See the system prompt for full format + examples.',
    "",
    bullets,
  ].join("\n");
}
