import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { Candidate } from "./planner.js";
import type { ContextItem } from "./context.js";

const ESSAY_SYSTEM = `You are writing one tomo — a Spanish essay (non-fiction) — for a single reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

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

const FLOW_SYSTEM = `You are writing one tomo — a Spanish "flow" piece — for a single reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

A flow tomo is more creative and less structured than an essay. You have wide latitude on shape and voice. Pick one and commit:
- a narrative scene (third-person past, or first-person present — you choose)
- a prose poem or lyrical reflection
- a stream-of-consciousness fragment
- a fragment-collage (numbered/titled vignettes)
- a dialogue or monologue
- a hybrid of any of the above

The only invariants:
- Spanish, A2/B1 register throughout. No untranslated technical jargon.
- Anchored on the source material provided — transformed, not quoted. The reader will not see the sources, only the finished tomo.
- Body of ~2000 words (1800-2400 acceptable).
- A final "## Para llevarte" section with 5-8 bullets distilling what the piece surfaced. Bullets are short Spanish sentences starting with "- ".
- No translation, no footnotes, no parenthetical English.

Wider latitude than essay-mode means: you can break linear time, use recurring images, leave things implicit, end on an image rather than a thesis. But the texture must still feel anchored to the reader's actual life — recognizable mirror text, not generic. Be specific. Name the texture.

Output format:
- "# <title>" on the first line.
- Blank line, then the body. Optional "## <heading>" Spanish section breaks allowed if the form calls for them (never named "Para llevarte").
- No markdown in the body other than headings (no bold, italic, lists, quotes, links, code) — except dialogue in straight double quotes "así".
- Blank line, then "## Para llevarte" with 5-8 bullets.
- End immediately after the last bullet — no closing paragraph, no "Fin", no author's note.`;

export async function write(
  plan: Candidate,
  style: string,
  context: ContextItem[],
  lookupsBlock = "",
  grammarBlock = "",
  highlightsBlock = ""
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

  const system = plan.format === "flow" ? FLOW_SYSTEM : ESSAY_SYSTEM;
  const planLabel = plan.format === "flow" ? "Tomo plan (flow)" : "Tomo plan";
  const closing =
    plan.format === "flow"
      ? 'Write the tomo now in Spanish. Pick a form that fits the angle. Target ~2000 words of body (1800-2400 acceptable). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.'
      : 'Write the tomo now in Spanish. Target ~2000 words of body (1800-2400 acceptable). After the body, append "## Para llevarte" with 5-8 distilled bullets, then stop. Start with the title heading.';

  const user = [
    "# Style guide",
    style,
    ...(lookupsBlock ? ["", lookupsBlock] : []),
    ...(grammarBlock ? ["", grammarBlock] : []),
    ...(highlightsBlock ? ["", highlightsBlock] : []),
    "",
    `# ${planLabel}`,
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
    closing,
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Writer returned no text block");
  }

  return textBlock.text.trim() + "\n";
}

export interface WordCounts {
  total: number;
}

export function countWords(markdown: string): WordCounts {
  const parts = splitTomo(markdown);
  const stripHeadings = (s: string): string => s.replace(/^##\s.+$/gm, "");
  const stripped = stripHeadings(parts.body).trim();
  if (stripped.length === 0) return { total: 0 };
  const total = stripped.split(/\s+/).filter((w) => w.length > 0).length;
  return { total };
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
