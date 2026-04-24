import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { ContextItem } from "./context.js";
import type { TomoSummary } from "./state.js";

const SYSTEM = `You are the editor of a personalized Spanish-language series written for one reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

Each issue is a "tomo" — a standalone mini-book of 1300-1600 words. Your job: pick the format and topic for the next tomo.

The reader wants each tomo to:
1. Be enjoyable to read in Spanish at his level.
2. Connect to something he actually journaled or noticed in the last two weeks.
3. Teach or illuminate something real from neuroscience, psychology, or technology — not just recap his life.

Two formats:
- "fiction": short story, character-driven, dramatizes an idea. 1300-1600 words.
- "essay": popular-science piece, warm and specific, teaches a real concept. 1300-1600 words.

Rules:
- Pick ONE format and ONE focused topic. Let the material decide which — don't default to essay.
- Topic must pair a journal theme with either a domain concept (neuro/psych/tech) or, if a pure story fits better, a concrete internal truth to dramatize.
- Do NOT retread topics or domains covered in the last 30 tomos. Variety matters.
- Pick 2-5 source UUIDs (from the provided pool) the tomo should draw from.
- Title is in Spanish, 3-8 words, evocative not literal.
- Don't pick a topic that would need >B1 technical Spanish to be accurate — either simplify the angle or pick a different topic.

Output STRICT JSON only — no prose, no markdown, no code fences:
{
  "format": "fiction" | "essay",
  "domain": "neuroscience" | "psychology" | "technology" | "none",
  "topic": "short phrase describing what this tomo is about",
  "angle": "1-2 sentences: the specific take — what makes this tomo worth reading",
  "title": "título en español",
  "source_refs": ["uuid1", "uuid2", ...]
}`;

export interface Plan {
  format: "fiction" | "essay";
  domain: "neuroscience" | "psychology" | "technology" | "none";
  topic: string;
  angle: string;
  title: string;
  source_refs: string[];
}

const SOURCE_PREVIEW_CHARS = 700;

export async function plan(
  style: string,
  recentTomos: TomoSummary[],
  context: ContextItem[]
): Promise<Plan> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the planner");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const contextBlock = context
    .map((c) => {
      const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
      const body = c.text.slice(0, SOURCE_PREVIEW_CHARS);
      return `${head}\n${body}`;
    })
    .join("\n\n---\n\n");

  const recentBlock =
    recentTomos.length === 0
      ? "(none yet — this is tomo 1)"
      : recentTomos
          .map(
            (c) =>
              `#${c.n} [${c.format}/${c.domain}] ${c.title} — ${c.topic}`
          )
          .join("\n");

  const user = [
    "# Style guide",
    style,
    "",
    "# Recent tomos — do not retread these topics/domains",
    recentBlock,
    "",
    "# Source material from the last 14 days",
    "(Entries and insights from the reader's journal. Quote UUIDs exactly as shown in brackets.)",
    "",
    contextBlock,
    "",
    "Pick the next tomo. Output JSON only.",
  ].join("\n");

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Planner returned no text block");
  }

  const match = textBlock.text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(
      "Planner returned no JSON object. Raw output:\n" + textBlock.text
    );
  }

  const parsed = JSON.parse(match[0]) as Plan;
  parsed.source_refs = parsed.source_refs.map(normalizeUuid);
  validatePlan(parsed, context);
  return parsed;
}

function normalizeUuid(ref: string): string {
  return ref.replace(/^(entry|insight):/, "").trim();
}

function validatePlan(p: Plan, context: ContextItem[]): void {
  const validUuids = new Set(context.map((c) => c.uuid));
  const unknown = p.source_refs.filter((u) => !validUuids.has(u));
  if (unknown.length > 0) {
    throw new Error(
      `Planner picked source UUIDs not in the context pool: ${unknown.join(", ")}`
    );
  }
  if (p.source_refs.length < 1) {
    throw new Error("Planner must pick at least 1 source UUID");
  }
  if (!["fiction", "essay"].includes(p.format)) {
    throw new Error(`Planner returned invalid format: ${p.format}`);
  }
}
