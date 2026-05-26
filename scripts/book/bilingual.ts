import { config } from "../../src/config.js";
import { bookChat } from "./llm.js";

const SYSTEM = `You are creating a side-by-side bilingual study version of a Spanish essay for an English-speaking learner. The reader wants to scan ES then EN inline to learn translations quickly.

Take the input Spanish markdown and output an interleaved version. For every Spanish sentence, immediately follow it (same line, separated by a single space) with the English translation in italics, so each ES↔EN pair reads as one continuous line on a Kindle.

Rules:
- Headings: keep "# " and "## " prefixes. Translate the heading text inline as "Título — English title".
- Body paragraphs: split into sentences. For each Spanish sentence, write the Spanish sentence, then a single space, then the English translation wrapped in single asterisks for italics. Each ES↔EN pair is one line. Separate pairs with a blank line (so each pair reads as its own paragraph).
- Bullets in "## Para llevarte": each Spanish bullet stays a bullet ("- ..."). Write the Spanish sentence, a single space, then the English translation in italics, all on one line. The next bullet starts on its own line.
- Treat short interjections, fragments, and quoted speech as their own sentence pairs.
- **Preserve inline grammar glosses verbatim.** Some Spanish sentences already contain an inline grammar gloss formatted as an italic parenthetical in English: \`(*"hubo" = a single completed event*)\`. Keep these glosses INSIDE the Spanish half exactly as written — same position, same asterisks, same text. Do NOT translate them, do NOT duplicate them in the English half, do NOT remove them. The English half that you append after the Spanish sentence is the translation of the surrounding Spanish prose, treating the gloss as if it were not there.
- Output pure markdown. No preamble, no commentary, no closing note.

Example of correct ES↔EN pairing in body:

Imagina que llevas años conduciendo por la misma ciudad. *Imagine you've spent years driving through the same city.* El mapa está en la cabeza — no tienes que pensar. *The map lives in your head — you don't have to think.*

Example with an inline gloss preserved verbatim:

Hubo (*"hubo" = a single completed event, vs. "había" = ongoing state*) muchos encuentros donde el deseo era conexión. *There were many encounters where the desire was connection.*

Example for a Para llevarte bullet:

- El cerebro no percibe la realidad directamente. *The brain does not perceive reality directly.*
- Un modelo formado en condiciones extremas no está roto. *A model formed under extreme conditions is not broken.*`;

export async function interleave(markdown: string): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the bilingual pass");
  }
  const text = await bookChat({
    model: config.models.anthropicFast,
    system: SYSTEM,
    messages: [{ role: "user", content: markdown }],
    maxTokens: 16000,
    label: "bilingual",
    progress: true,
  });
  return text.trim() + "\n";
}
