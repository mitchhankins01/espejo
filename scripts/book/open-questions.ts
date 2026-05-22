import { readFile } from "fs/promises";

const TOMO_PROMPT_PATH = "Artifacts/Prompt/Spanish/Tomo.md";
const BEGIN = "<!-- BEGIN OPEN QUESTIONS";
const END = "<!-- END OPEN QUESTIONS";

export async function readOpenQuestions(
  path: string = TOMO_PROMPT_PATH
): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return [];
  const blockStart = text.indexOf("\n", start) + 1;
  const block = text.slice(blockStart, end);
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
