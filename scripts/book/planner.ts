import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { ContextItem } from "./context.js";
import type { TomoSummary } from "./state.js";

const SYSTEM = `You are the editor of a personalized Spanish-language series written for one reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

Each issue is a "tomo" — a standalone mini-book of 1950-2400 words. Your job: pick the format and topic for the next tomo.

The reader wants each tomo to:
1. Be enjoyable to read in Spanish at his level.
2. Connect to a life pattern or preoccupation he actually journaled or noticed in the last two weeks — even loosely, as emotional substrate. Every tomo, fiction or essay, must tie to his life.
3. Illuminate that pattern through one of these domains: neuroscience, psychology, physics, psychedelics, robotics, AI.

Two formats:
- "fiction": short story, character-driven, dramatizes an idea. 1950-2400 words. Science fiction is actively encouraged: interstellar travel, generation ships, first contact, utopias and dystopias, post-scarcity societies, uploaded minds, terraforming, robotic companions, emergent AI — anywhere on the spectrum. For sci-fi, source entries/insights serve as emotional substrate (a character's inner pattern, a felt question, a recognizable human moment); the world itself can be invented using general knowledge, grounded in the chosen domain (e.g. physics-accurate travel, plausible neuroscience, grounded AI behavior). The story does not have to take place in Barcelona or in the present day. A fiction tomo may also seed a recurring sub-series: if the world, character, or question is rich enough to return to, the angle should flag it as a series opener. Even as a series opener the tomo is a complete story — no cliffhangers, no teasers, no "to be continued".
- "essay": popular-science piece, warm and specific, teaches a real concept. 1950-2400 words.

Rules:
- Pick ONE format and ONE focused topic. Let the material decide — don't default to essay. Actively rotate formats: if the last 1-2 tomos were essays, strongly favor fiction (and consider sci-fi).
- Every plan MUST pick a domain from: neuroscience, psychology, physics, psychedelics, robotics, ai. No "none". The domain is the lens — it can be the subject of an essay or the grounding of a sci-fi world.
- For essays: topic pairs a journal theme with the chosen domain concept.
- For fiction (including sci-fi): pick a concrete internal truth from the journal to dramatize and a domain to ground the world/characters/conflict.
- If the plan is a series opener, set "series_seed" to true and name the series in the angle. Otherwise set it to false.
- Do NOT retread topics or domains covered in the last 30 tomos. Variety matters.
- Pick 2-5 source UUIDs (from the provided pool) the tomo should draw from. For sci-fi, these can be loose emotional anchors rather than literal subject matter.
- Title is in Spanish, 3-8 words, evocative not literal.
- Don't pick a topic that would need >B1 technical Spanish to be accurate — either simplify the angle or pick a different topic.

Output STRICT JSON only — no prose, no markdown, no code fences:
{
  "format": "fiction" | "essay",
  "domain": "neuroscience" | "psychology" | "physics" | "psychedelics" | "robotics" | "ai",
  "topic": "short phrase describing what this tomo is about",
  "angle": "1-2 sentences: the specific take — what makes this tomo worth reading. If series_seed, name the series.",
  "series_seed": true | false,
  "title": "título en español",
  "source_refs": ["uuid1", "uuid2", ...]
}`;

export type Domain =
  | "neuroscience"
  | "psychology"
  | "physics"
  | "psychedelics"
  | "robotics"
  | "ai";

export interface Plan {
  format: "fiction" | "essay";
  domain: Domain;
  topic: string;
  angle: string;
  series_seed: boolean;
  title: string;
  source_refs: string[];
}

const SOURCE_PREVIEW_CHARS = 700;

export async function plan(
  style: string,
  recentTomos: TomoSummary[],
  context: ContextItem[],
  steer?: string
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

  const steerBlock = steer
    ? [
        "# Editorial direction for this tomo (highest priority)",
        "The reader has given a specific redirect. Honor it unless it conflicts with the hard rules (format enum, domain enum, word count, B1-level).",
        "",
        steer,
        "",
      ]
    : [];

  const user = [
    "# Style guide",
    style,
    "",
    "# Recent tomos — do not retread these topics/domains",
    recentBlock,
    "",
    ...steerBlock,
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
  const validDomains = ["neuroscience", "psychology", "physics", "psychedelics", "robotics", "ai"];
  if (!validDomains.includes(p.domain)) {
    throw new Error(
      `Planner returned invalid domain: ${p.domain}. Must be one of ${validDomains.join(", ")}`
    );
  }
  if (typeof p.series_seed !== "boolean") {
    throw new Error(`Planner must return series_seed as boolean, got: ${p.series_seed}`);
  }
}
