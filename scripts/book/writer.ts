import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { Plan } from "./planner.js";
import type { ContextItem } from "./context.js";
import type { MythEntry } from "./myths.js";

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
- Blank line, then prose body in paragraphs. 2-4 optional "## <heading>" Spanish section breaks allowed (never named "Para llevarte" or "El espejo").
- No markdown in the body other than headings (no bold, italic, lists, quotes, links, code).
- Blank line, then "## Para llevarte" with bullets.
- End immediately after the last bullet — no closing paragraph, no "Fin", no author's note.`;

const MYTH_SYSTEM = `You are writing one tomo — a Spanish mythology mini-book — for a single reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

A myth-tomo has THREE sections in this exact order:

## Section 1: the myth retold (1100-1500 words)
Open the tomo with the myth as a literary scene in past tense. Third-person, no "Imagínate..." or "Tú eres..." second-person. Indefinido and imperfecto carry the action — this matches the reader's active grammar focus, so use them naturally and densely.

Honor the canonical shape of the myth. Use the corpus summary as your factual baseline; do not invent plot points that contradict canon. Stylistic license is fine; factual contradiction is not.

This section can have one optional "## <Spanish-heading>" inside it for a scene break. Do NOT use "## El espejo" or "## Para llevarte" inside this section.

## Section 2: "## El espejo" — the bridge (400-600 words)
After the myth, on its own line, write exactly: "## El espejo"

Below the heading, switch to second-person addressing Mitch directly ("tú", "tu semana", "lo que vivías..."). Develop the bridge_thesis from the plan — name how the myth's shape maps to the recent lived material. Draw on the source material provided; transform it, don't quote verbatim.

The bridge stands as recognizable mirror text — a reader who reads only this section (without the myth above) should still feel "this is about my week," not generic essay-voice. Be specific. Name the texture.

## Section 3: "## Para llevarte" (5-8 bullets)
After the bridge, on its own line, write exactly: "## Para llevarte"

5-8 short bullets, one Spanish sentence each, starting with "- ". INTERLEAVE bullets that distill the myth's universal lesson with bullets that name what it surfaced about the week. Do NOT segregate them (myth bullets on top, personal on bottom). Do NOT restate the bridge_thesis verbatim.

Other rules:
- No translation, no footnotes, no parenthetical English.
- No markdown other than headings (no bold, italic, lists in the body, quotes, links, code).
- Direct dialogue in straight double quotes: "así".
- B1-level Spanish throughout. Gloss technical or obscure terms in-prose if unavoidable.
- End immediately after the last takeaway bullet — no closing paragraph, no "Fin", no author's note.

Output format:
- "# <title>" on the first line.
- Blank line, then the myth section.
- Blank line, then "## El espejo" + the bridge.
- Blank line, then "## Para llevarte" + the bullets.
- End.`;

export async function write(
  plan: Plan,
  style: string,
  context: ContextItem[],
  lookupsBlock = "",
  grammarBlock = "",
  highlightsBlock = "",
  mythEntry: MythEntry | null = null
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

  let user: string;
  let system: string;

  if (plan.format === "myth") {
    if (!mythEntry) {
      throw new Error("write(format=myth) requires mythEntry");
    }
    if (!plan.myth_name || !plan.bridge_thesis) {
      throw new Error("write(format=myth) requires plan.myth_name and plan.bridge_thesis");
    }
    system = MYTH_SYSTEM;
    user = [
      "# Style guide",
      style,
      ...(lookupsBlock ? ["", lookupsBlock] : []),
      ...(grammarBlock ? ["", grammarBlock] : []),
      ...(highlightsBlock ? ["", highlightsBlock] : []),
      "",
      "# Tomo plan (myth-mode)",
      `- Título: ${plan.title}`,
      `- Mito: ${plan.myth_name}`,
      `- Tema: ${plan.topic}`,
      `- Ángulo: ${plan.angle}`,
      `- Bridge thesis: ${plan.bridge_thesis}`,
      "",
      "# Myth corpus entry (canonical baseline)",
      `Name: ${mythEntry.name} (${mythEntry.culture})`,
      `Shape: ${mythEntry.shape}`,
      `Motifs: ${mythEntry.motifs.join(", ")}`,
      `Vocabulary hints (use naturally where they fit): ${mythEntry.vocabulary_hints.join(", ")}`,
      "",
      "Canon summary:",
      mythEntry.summary_es,
      "",
      "# Source material for the bridge",
      "Draw from these — transform them into the bridge section. Do not quote the reader's entries verbatim. The reader will not see these sources, only the finished tomo.",
      "",
      sourcesBlock,
      "",
      'Write the tomo now. Begin with the title heading. The myth section is 1100-1500 words; the bridge is 400-600 words; the takeaways are 5-8 bullets. Use the exact headings "## El espejo" and "## Para llevarte".',
    ].join("\n");
  } else {
    system = ESSAY_SYSTEM;
    user = [
      "# Style guide",
      style,
      ...(lookupsBlock ? ["", lookupsBlock] : []),
      ...(grammarBlock ? ["", grammarBlock] : []),
      ...(highlightsBlock ? ["", highlightsBlock] : []),
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
  }

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
  myth?: number;
  bridge?: number;
}

export function countWords(markdown: string): WordCounts {
  const parts = splitTomo(markdown);
  const stripHeadings = (s: string): string => s.replace(/^##\s.+$/gm, "");
  const count = (s: string): number => {
    const stripped = stripHeadings(s).trim();
    if (stripped.length === 0) return 0;
    return stripped.split(/\s+/).filter((w) => w.length > 0).length;
  };

  if (parts.myth !== undefined && parts.bridge !== undefined) {
    const myth = count(parts.myth);
    const bridge = count(parts.bridge);
    return { total: myth + bridge, myth, bridge };
  }
  return { total: count(parts.body) };
}

export interface TomoParts {
  title: string;
  body: string;
  myth?: string;
  bridge?: string;
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

  const preTakeaways = withoutTitle.slice(0, takeawaysIdx).trim();
  const takeaways = withoutTitle.slice(takeawaysIdx).trim();

  const espejoIdx = preTakeaways.search(/^##\s+El espejo\s*$/m);
  if (espejoIdx === -1) {
    return { title, body: preTakeaways, takeaways };
  }

  const myth = preTakeaways.slice(0, espejoIdx).trim();
  const bridge = preTakeaways.slice(espejoIdx).trim();
  return { title, body: preTakeaways, myth, bridge, takeaways };
}
