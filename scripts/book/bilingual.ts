import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";

const SYSTEM = `You are creating a side-by-side bilingual study version of a Spanish essay for an A2/B1 English-speaking learner. The reader wants to scan ES then EN inline to learn translations quickly.

Take the input Spanish markdown and output an interleaved version. For every Spanish sentence, immediately follow it (same line, separated by a single space) with the natural English translation in italics, so each ES↔EN pair reads as one continuous line on a Kindle.

Rules:
- Headings: keep "# " and "## " prefixes. Translate the heading text inline as "Título — English title".
- Body paragraphs: split into sentences. For each Spanish sentence, write the Spanish sentence, then a single space, then the English translation wrapped in single asterisks for italics. Each ES↔EN pair is one line. Separate pairs with a blank line (so each pair reads as its own paragraph).
- Bullets in "## Para llevarte": each Spanish bullet stays a bullet ("- ..."). Write the Spanish sentence, a single space, then the English translation in italics, all on one line. The next bullet starts on its own line.
- Translate naturally, not literally. Preserve nuance, tone, and idiom. The English should read clearly to a learner — not awkward word-for-word.
- Treat short interjections, fragments, and quoted speech as their own sentence pairs.
- Output pure markdown. No preamble, no commentary, no closing note.

Example of correct ES↔EN pairing in body:

Imagina que llevas años conduciendo por la misma ciudad. *Imagine you've spent years driving through the same city.*

El mapa está en la cabeza — no tienes que pensar. *The map lives in your head — you don't have to think.*

Example for a Para llevarte bullet:

- El cerebro no percibe la realidad directamente. *The brain does not perceive reality directly.*
- Un modelo formado en condiciones extremas no está roto. *A model formed under extreme conditions is not broken.*`;

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
