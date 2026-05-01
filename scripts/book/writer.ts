import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { Plan } from "./planner.js";
import type { ContextItem } from "./context.js";

const SYSTEM = `You are writing one tomo — a Spanish essay (non-fiction) — for a single reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

A tomo is a standalone ~2000-word essay. No references to previous tomos. No translation, no footnotes, no parenthetical English.

Follow the style guide. Respect the reader's grammar level. Lean into the recently-learned vocabulary listed in the style guide. Let current grammar foci appear naturally — don't force them.

The essay teaches a real concept with specificity, anchored to a pattern from the reader's life:
- Open with a concrete hook — a scene, a question, a moment in his journal. Never an abstract or "En este tomo vamos a..." intro.
- Use examples. One specific example beats three generalizations.
- Gloss technical terms in-prose when unavoidable: "la plasticidad — la capacidad del cerebro de cambiar —".
- Direct quotations use straight double quotes: "así".
- The intersection between life pattern and domain concept must be real — illuminate, don't decorate.
- Don't preach or summarize inside the body. Distillation belongs in the takeaways section.

Length: target ~2000 words of Spanish body (1800-2400 acceptable). If you hit a natural ending under 1800, extend with one more beat — a remembered scene, an aftermath, a sensory dwell on a detail already introduced. Don't pad with summary.

After the body, append a final takeaways section:
- Heading: exactly "## Para llevarte" (no variant).
- 5-8 short bullets, one Spanish sentence each, starting with "- ".
- Distill the actual ideas, observations, contrasts — not the structure of the argument.
- Excluded from the body word count.

Output format:
- "# <title>" on the first line.
- Blank line, then prose body in paragraphs. 2-4 optional "## <heading>" Spanish section breaks allowed (never named "Para llevarte").
- No markdown in the body other than headings (no bold, italic, lists, quotes, links, code).
- Blank line, then "## Para llevarte" with bullets.
- End immediately after the last bullet — no closing paragraph, no "Fin", no author's note.`;

export async function write(
  plan: Plan,
  style: string,
  context: ContextItem[],
  lookupsBlock = "",
  grammarBlock = ""
): Promise<string> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the writer");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const sources = context.filter((c) => plan.source_refs.includes(c.uuid));
  const sourcesBlock = sources
    .map((c) => {
      const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
      return `${head}\n${c.text.slice(0, 2000)}`;
    })
    .join("\n\n---\n\n");

  const user = [
    "# Style guide",
    style,
    ...(lookupsBlock ? ["", lookupsBlock] : []),
    ...(grammarBlock ? ["", grammarBlock] : []),
    "",
    "# Tomo plan",
    `- Título: ${plan.title}`,
    `- Dominio: ${plan.domain}`,
    `- Tema: ${plan.topic}`,
    `- Ángulo: ${plan.angle}`,
    "",
    "# Source material",
    "Draw from these — transform them into the tomo. Do not quote the reader's entries verbatim. The reader will not see these sources, only the finished tomo.",
    "",
    sourcesBlock,
    "",
    'Write the tomo now in Spanish. Target ~2000 words of body (1800-2400 acceptable). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.',
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8192,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Writer returned no text block");
  }

  return textBlock.text.trim() + "\n";
}

export function countWords(markdown: string): number {
  const { body } = splitTomo(markdown);
  const stripped = body.replace(/^##\s.+$/gm, "");
  const words = stripped.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

export interface TomoParts {
  title: string;
  body: string;
  takeaways: string;
}

export function splitTomo(markdown: string): TomoParts {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const withoutTitle = markdown.replace(/^#\s+.+\n?/, "");
  const takeawaysIdx = withoutTitle.search(/^##\s+Para llevarte\s*$/m);
  if (takeawaysIdx === -1) {
    return { title, body: withoutTitle.trim(), takeaways: "" };
  }
  const body = withoutTitle.slice(0, takeawaysIdx).trim();
  const takeaways = withoutTitle.slice(takeawaysIdx).trim();
  return { title, body, takeaways };
}
