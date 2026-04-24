import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { Plan } from "./planner.js";
import type { ContextItem } from "./context.js";

const SYSTEM = `You are writing one tomo — a standalone Spanish mini-book — for a single reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

Each tomo is standalone. No references to previous tomos, no "en el tomo anterior", no teasers for the next.

Output: 1300-1600 words of Spanish prose. Entirely in Spanish. No translation, no footnotes, no parenthetical English, no glossary.

Follow the style guide provided. Respect the reader's grammar level. Let current grammar foci (imperfecto vs pretérito with mental states, subjuntivo pasado after verbs of wanting/preferring in the past) appear naturally in the prose. Don't force them.

Lean into vocabulary he's recently learned — pull from the style guide.

If format is "essay":
- Teach a real concept with specificity. Facts must be accurate.
- Open with a concrete hook — a scene, a question, a case. Not an abstract.
- Use examples. One good example beats three generalizations.
- Gloss technical terms in-prose when unavoidable: "la plasticidad — la capacidad del cerebro de cambiar —".
- Never start with "En este tomo vamos a..." or similar meta-intros.

If format is "fiction":
- One short complete story. At least one character, a setting, a turn, an ending.
- Dramatize the idea — never state it outright. No moral at the end.
- Dialogue is fine and good.

Never preach, moralize, or summarize at the end. Let the prose do the work.

Output format — exactly:
- First line: "# <title>"
- Blank line
- Prose body in paragraphs. 2-4 optional "## <heading>" section breaks allowed (Spanish titles).
- No other markdown: no bold, italic, lists, quotes, links, code.
- End when done. No meta-commentary, no author's note.
- Body word count: 1300-1600 words excluding the title.`;

export async function write(
  plan: Plan,
  style: string,
  context: ContextItem[],
  lookupsBlock = ""
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
    "",
    "# Tomo plan",
    `- Título: ${plan.title}`,
    `- Formato: ${plan.format}`,
    `- Dominio: ${plan.domain}`,
    `- Tema: ${plan.topic}`,
    `- Ángulo: ${plan.angle}`,
    "",
    "# Source material",
    "Draw from these — transform them into the tomo. Do not quote the reader's entries verbatim. The reader will not see these sources, only the finished tomo.",
    "",
    sourcesBlock,
    "",
    "Write the tomo now. 1300-1600 words of Spanish body text. Start with the title heading.",
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
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
  const body = markdown.replace(/^#\s.+$/m, "").replace(/^##\s.+$/gm, "");
  const words = body.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}
