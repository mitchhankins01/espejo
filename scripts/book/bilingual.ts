import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";

const SYSTEM = `You are creating a side-by-side bilingual study version of a Spanish essay for an A2/B1 English-speaking learner. The reader wants to scan ES then EN line by line to learn translations quickly.

Take the input Spanish markdown and output an interleaved version. For every Spanish sentence, immediately follow it with the natural English translation in italics on the next line.

Rules:
- Headings: keep "# " and "## " prefixes. Translate the heading text inline as "Título — English title".
- Body paragraphs: split into sentences. Each Spanish sentence on its own line; on the line directly below, the same sentence translated to natural English wrapped in single asterisks for italics. Insert a blank line between sentence pairs so the rhythm is clear on a Kindle.
- Bullets in "## Para llevarte": each Spanish bullet stays a bullet ("- ..."); on the line directly below the bullet, the English translation in italics, indented with two spaces ("  *...*"). Blank line between bullet pairs.
- Translate naturally, not literally. Preserve nuance, tone, and idiom. The English should read clearly to a learner — not awkward word-for-word.
- Treat short interjections, fragments, and quoted speech as their own sentence pairs.
- If the source contains a "## El espejo" heading, the section above is a literary myth retelling in past tense — keep the EN translation in matching literary register (no contemporary contractions, retain the third-person past). The section below "El espejo" is a second-person bridge — translate the EN matching essay voice. The "## Para llevarte" bullets interleave myth lesson and personal resonance — maintain a consistent reflective tone across both kinds.
- Output pure markdown. No preamble, no commentary, no closing note.`;

export async function interleave(markdown: string): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the bilingual pass");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: markdown }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Bilingual pass returned no text block");
  }
  return text.text.trim() + "\n";
}
