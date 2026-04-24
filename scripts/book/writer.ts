import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { Plan } from "./planner.js";
import type { ContextItem } from "./context.js";

const SYSTEM = `You are writing one tomo — a Spanish mini-book — for a single reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

Each tomo is a complete reading experience — no cliffhangers, no "to be continued", no teasers for the next. No references to previous tomos ("en el tomo anterior" etc.).

If the plan marks this tomo as a series opener (series_seed: true), establish the world, character, and central question richly enough that future tomos could return to this setting. Still deliver a complete story arc — beginning, middle, end, resolution on the central scene — inside this single tomo. A first-book-of-a-series ends at a satisfying pause, not a cliffhanger.

Output: 1950-2400 words of Spanish prose. Entirely in Spanish. No translation, no footnotes, no parenthetical English, no glossary.

Follow the style guide provided. Respect the reader's grammar level. Let current grammar foci (imperfecto vs pretérito with mental states, subjuntivo pasado after verbs of wanting/preferring in the past) appear naturally in the prose. Don't force them.

Lean into vocabulary he's recently learned — pull from the style guide.

If format is "essay":
- Teach a real concept with specificity. Facts must be accurate.
- Open with a concrete hook — a scene, a question, a case. Not an abstract.
- Use examples. One good example beats three generalizations.
- Gloss technical terms in-prose when unavoidable: "la plasticidad — la capacidad del cerebro de cambiar —".
- Never start with "En este tomo vamos a..." or similar meta-intros.
- If you quote a person (speech or reported speech), use straight double quotes: "así". Same rule as fiction — the reader must be able to see at a glance where a voice begins and ends.

If format is "fiction":
- One short complete story. At least one character, a setting, a turn, an ending.
- Dramatize the idea — never state it outright. No moral at the end.
- Dialogue is fine and good. All spoken dialogue MUST be wrapped in straight double quotes: "así". Never use guion largo (— speech —), never leave dialogue inline without quotes, never use curly/smart quotes. Example: Marco dijo: "No sé qué haría con ello." Thoughts and sensed-but-unspoken words stay unquoted — only actual spoken words get the quotes. This rule is non-negotiable: the reader cannot distinguish narration from speech without it.
- For science fiction (interstellar travel, generation ships, utopias/dystopias, post-scarcity, uploaded minds, terraforming, far futures, first contact): build the world in concrete, sensory detail. Invent freely — the reader's source entries are emotional substrate (a felt question, an inner pattern), not literal subject matter. Ground speculative elements in plausible physics/sociology/philosophy; avoid magic-tech handwaving. The story can take place anywhere, any time — not Barcelona, not the present, unless the plan says otherwise.

Never preach, moralize, or summarize at the end. Let the prose do the work.

Length is a HARD FLOOR, not a passive target. Body word count (excluding the title heading) MUST be between 1950 and 2400 words. If you reach what feels like a natural ending before 1950 words, you have NOT finished. Extend — not with padding or summary, but with one more beat: a remembered scene, a secondary character moment, an aftermath paragraph, a sensory dwell on a detail already introduced, a second turn to the decision, a quiet passage where the body or the setting has room to breathe. Short tomos have been a recurring problem; do not stop early.

Output format — exactly:
- First line: "# <title>"
- Blank line
- Prose body in paragraphs. 2-4 optional "## <heading>" section breaks allowed (Spanish titles).
- No other markdown: no bold, italic, lists, quotes, links, code.
- End only when the story is complete AND word count is at least 1950. No meta-commentary, no author's note.`;

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
    `- Series opener: ${plan.series_seed ? "yes — establish the world/character for future tomos, still deliver a complete standalone arc" : "no"}`,
    "",
    "# Source material",
    "Draw from these — transform them into the tomo. Do not quote the reader's entries verbatim. The reader will not see these sources, only the finished tomo.",
    "",
    sourcesBlock,
    "",
    "Write the tomo now. MINIMUM 1950 words, MAXIMUM 2400 words of Spanish body text. If you reach a natural ending under 1950, extend with one more beat — a memory, a secondary moment, an aftermath — do not summarize or wrap up early. Start with the title heading.",
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 6144,
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
