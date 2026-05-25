import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/client.js";

const READER_LEVEL_SYSTEM = `You read a stack of Spanish-language journal entries and produce ONE short English paragraph (4-7 sentences) describing the writer's current Spanish level: confident structures, structures dodged, sentence-length growth, recurring errors, code-switch tells, and improvement deltas over the period. This paragraph is a time-capsule snapshot — concrete and specific, not generic. It is consumed by the Phase 1 menu surface read.

Hard rules:
- One paragraph, no headings, no bullets, no preamble.
- Name specific structures by name (preterit/imperfect contrast, subjunctive after desiderative verbs, conditional sequencing, reflexive constructions, gendered noun agreement, etc.) — not generic phrases.
- Quote a 2-5 word fragment from the entries when it helps illustrate a pattern.
- Honest, not flattering. Note the dodges and code-switches without judgment.`;

export async function generateReaderLevelParagraph(
  entries: { date: string; text: string }[]
): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for reader-level");
  }
  if (entries.length === 0) {
    return "Not enough recent Spanish-language journaling to produce a reliable level snapshot.";
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const corpus = entries
    .map((e) => `[${e.date}]\n${e.text.slice(0, 1500)}`)
    .join("\n\n---\n\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 600,
    system: READER_LEVEL_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Here are recent Spanish-language journal entries from the writer. Produce the one-paragraph level snapshot.\n\n${corpus}`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Reader-level call returned no text block");
  }
  return block.text.trim();
}

export async function fetchRecentSpanishEntries(
  daysBack = 90,
  minSpanishChars = 5
): Promise<{ date: string; text: string }[]> {
  const sinceDate = new Date(Date.now() - daysBack * 86400000)
    .toISOString()
    .slice(0, 10);
  const res = await pool.query(
    `SELECT created_at, text
       FROM entries
      WHERE created_at >= $1
        AND length(regexp_replace(text, '[^áéíóúñÁÉÍÓÚÑ¿¡]', '', 'g')) >= $2
      ORDER BY created_at DESC`,
    [sinceDate, minSpanishChars]
  );
  return res.rows.map((r) => ({
    date: (r.created_at as Date).toISOString().slice(0, 10),
    text: r.text as string,
  }));
}
