import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { ContextItem } from "./context.js";
import type { MythEntry } from "./myths.js";
import { formatMythCorpusForPlanner } from "./myths.js";

export interface MythScore {
  name: string;
  score: number;
  reason: string;
}

const SYSTEM = `You are scoring a curated mythology corpus against the recent context (insights + journal entries) of a single reader to decide which myth's SHAPE most resonates with what they're actually living right now.

For each myth in the corpus, output a fit score from 0 to 10 and a one-line reason. The score reflects how well the myth's shape (its theme, its motifs, its structural arc) matches the texture of the reader's recent material — not just keyword overlap.

Calibration:
- 9-10: shape illuminates the week — a tomo built around this myth would have an inevitable bridge, where the connection writes itself.
- 7-8: strong resonance — the myth fits but is one of several plausible angles.
- 4-6: partial resonance — some motifs match but the overall shape isn't quite right.
- 0-3: weak or no resonance — myth would feel decorative rather than mirror-like.

Hard rules:
- Score ALL myths in the corpus.
- The reason must be concrete: name the motif, the source UUID, or the specific texture that justifies the score. No generic phrases like "good fit for reflection."
- Honor the excluded list (these have fired in the last N tomos and should be marked excluded with score 0).

Output STRICT JSON only:
{
  "scores": [
    {"name": "Sísifo", "score": 9.2, "reason": "racha rota in source 3afb...; the descent register matches the relief Mitch named on 4-29"},
    {"name": "Ícaro", "score": 4.1, "reason": "weak — no judge-led ascent in this window"},
    ...
  ]
}`;

export async function scoreMyths(
  myths: MythEntry[],
  context: ContextItem[],
  longArc: ContextItem[],
  excludedNames: Set<string>
): Promise<MythScore[]> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the myth scorer");
  }
  if (myths.length === 0) return [];
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const formatItem = (c: ContextItem): string => {
    const head = `[${c.kind}:${c.uuid.slice(0, 8)}] ${c.date}${c.title ? " — " + c.title : ""}`;
    return `${head}\n${c.text.slice(0, 500)}`;
  };

  const longArcBlock =
    longArc.length === 0 ? "(none)" : longArc.map(formatItem).join("\n\n---\n\n");
  const recentBlock =
    context.length === 0 ? "(none)" : context.map(formatItem).join("\n\n---\n\n");
  const excludedBlock =
    excludedNames.size === 0
      ? "(none)"
      : Array.from(excludedNames).join(", ");

  const user = [
    "# Mythology corpus",
    formatMythCorpusForPlanner(myths),
    "",
    "# Excluded (fired in recent tomos — score 0 with reason 'recently fired')",
    excludedBlock,
    "",
    "# Standing themes (long-arc insights)",
    longArcBlock,
    "",
    "# Recent material (last 14 days)",
    recentBlock,
    "",
    "Score every myth. Output JSON only.",
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Myth scorer returned no text block");
  }

  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Myth scorer returned no JSON. Raw output:\n" + textBlock.text);
  }

  const parsed = JSON.parse(match[0]) as { scores: MythScore[] };
  return parsed.scores.sort((a, b) => b.score - a.score);
}
