import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/client.js";
import type { Candidate } from "./planner.js";
import type { Lookup } from "./lookups.js";
import type { Highlight } from "./highlights.js";

const READER_LEVEL_SYSTEM = `You read a stack of Spanish-language journal entries and produce ONE short English paragraph (4-7 sentences) describing the writer's current Spanish level: confident structures, structures dodged, sentence-length growth, recurring errors, code-switch tells, and improvement deltas over the period. This paragraph is a time-capsule snapshot — concrete and specific, not generic. It will be embedded in books the writer reads, so they can later see how their Spanish was at this moment.

Hard rules:
- One paragraph, no headings, no bullets, no preamble.
- Name specific structures by name (preterit/imperfect contrast, subjunctive after desiderative verbs, conditional sequencing, reflexive constructions, gendered noun agreement, etc.) — not generic phrases.
- Quote a 2-5 word fragment from the entries when it helps illustrate a pattern.
- Honest, not flattering. Note the dodges and code-switches without judgment.`;

const READER_NOTES_SYSTEM = `You are writing the Reader notes section that closes each Spanish-language tomo. The reader is a B1 Spanish learner; the Reader notes are in ENGLISH, written for him to read after finishing the Spanish piece.

Two parts:

1. **Your progress this period** — use the reader-level paragraph provided in the user message verbatim, or condense it lightly if it's longer than ~80 words. This is a time-capsule snapshot of where the reader's Spanish stands right now.

2. **What this tomo works on** — 3-6 bullets that name CONCRETELY:
   - Grammar structures the tomo exercises (read the tomo body in the user message — name the actual structures it uses: "condicional in hypothetical clauses", "preterite-imperfect contrast in the opening scene", "subjunctive after 'antes de que' and 'sin que'", "imperative + clitic pronouns in dialogue", etc.).
   - Vocab the reader will see again from recent Kindle lookups — quote 4-8 specific stems from the lookups block that actually appear in the tomo OR are in the same semantic field.
   - Any grammatical forms the reader recently highlighted on Kindle (compound past, conditional, past subjunctive) that the tomo re-exposes.

Hard rules:
- ENGLISH throughout.
- Output exactly:
  ## Reader notes

  **Your progress this period**

  <paragraph>

  **What this tomo works on**

  - <bullet>
  - <bullet>
  - <bullet>
  (3-6 bullets, each one a complete short sentence)
- No preamble, no closing, no "Note:" prefix.
- Specific, not generic. "Reflexive verbs" is too vague — name them: "reflexive verbs in the somatic register (acomodarse, contraerse, soltarse)".
- The bullets describe what the tomo DOES, not what it's about thematically.`;

export async function generateReaderLevelParagraph(
  entries: { date: string; text: string }[]
): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for reader-notes");
  }
  if (entries.length === 0) {
    return "Not enough recent Spanish-language journaling to produce a reliable level snapshot.";
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const corpus = entries
    .slice(0, 40)
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

export async function generateReaderNotes(args: {
  picked: Candidate;
  tomoMarkdown: string;
  readerLevel: string;
  recentLookups: Lookup[];
  recentHighlights: Highlight[];
}): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for reader-notes");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const lookupsLine = args.recentLookups
    .slice(0, 30)
    .map((l) => l.stem)
    .join(", ");
  const highlightsLine = args.recentHighlights
    .slice(0, 12)
    .map((h) => h.text.slice(0, 80))
    .join(" | ");

  const body = args.tomoMarkdown
    .replace(/^##\s+Reader notes[\s\S]*$/m, "")
    .trim();

  const user = `# Reader-level paragraph (use as "Your progress this period")
${args.readerLevel}

# Picked candidate
- Title: ${args.picked.title}
- Format: ${args.picked.format}
- Domain: ${args.picked.domain}
- Topic: ${args.picked.topic}
- Angle: ${args.picked.angle}

# Recent Kindle lookups (vocab — stems)
${lookupsLine}

# Recent Kindle highlights (grammar uncertainties — fragments)
${highlightsLine}

# The tomo (read this to name the grammar/vocab it actually uses)
${body}

Write the Reader notes section now.`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1200,
    system: READER_NOTES_SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Reader-notes call returned no text block");
  }
  let out = block.text.trim();
  if (!/^##\s+Reader notes\s*$/m.test(out)) {
    out = `## Reader notes\n\n${out}`;
  }
  return out + "\n";
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
      ORDER BY created_at DESC
      LIMIT 40`,
    [sinceDate, minSpanishChars]
  );
  return res.rows.map((r) => ({
    date: (r.created_at as Date).toISOString().slice(0, 10),
    text: r.text as string,
  }));
}

export function appendReaderNotesToMarkdown(
  tomoMarkdown: string,
  notes: string
): string {
  const trimmed = tomoMarkdown.trimEnd();
  if (/^##\s+Reader notes\s*$/m.test(trimmed)) {
    return trimmed
      .replace(/^##\s+Reader notes[\s\S]*$/m, notes.trimEnd())
      .concat("\n");
  }
  return `${trimmed}\n\n${notes.trimEnd()}\n`;
}
