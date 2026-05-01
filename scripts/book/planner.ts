import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { ContextItem } from "./context.js";
import type { TomoSummary } from "./state.js";

const SYSTEM = `You are the editor of a personalized Spanish-language essay series for one reader (Mitch), an A2/B1 Spanish learner living in Barcelona.

Each issue is a "tomo" — a standalone ~2000-word essay (non-fiction). Your job: pick the topic, angle, and source material for the next tomo.

Each tomo:
1. Reads enjoyably in Spanish at his level.
2. Anchors on a long-running pattern, preoccupation, or theme in his life — drawn from the Standing themes block (insights distilled over months of journaling) — and uses Recent material as fresh substrate.
3. Illuminates that pattern through one of these domains: neuroscience, cognition, psychology, philosophy, hermeticism, physics, psychedelics, ai.

Rules:
- Pick ONE focused topic and ONE domain. The domain is the lens through which the pattern is examined.
- The intersection must be real. Pair a long-arc theme with a domain concept that genuinely illuminates it — no surface name-drops, no forced metaphors.
- Do NOT retread topics or domains covered in the last 30 tomos. Variety matters.
- Pick 2-5 source UUIDs from the provided pools. Mix Standing themes (the anchor) with Recent material (the live texture). Quote UUIDs exactly as shown in brackets.
- Title: Spanish, 3-8 words, evocative not literal.
- Don't pick a topic that needs >B1 technical Spanish to be accurate — simplify the angle or pick a different topic.

Output STRICT JSON only — no prose, no markdown, no code fences:
{
  "domain": "neuroscience" | "cognition" | "psychology" | "philosophy" | "hermeticism" | "physics" | "psychedelics" | "ai",
  "topic": "short phrase describing what this tomo is about",
  "angle": "1-2 sentences: the specific take — what makes this tomo worth reading",
  "title": "título en español",
  "source_refs": ["uuid1", "uuid2", ...]
}`;

export type Domain =
  | "neuroscience"
  | "cognition"
  | "psychology"
  | "philosophy"
  | "hermeticism"
  | "physics"
  | "psychedelics"
  | "ai";

const VALID_DOMAINS: Domain[] = [
  "neuroscience",
  "cognition",
  "psychology",
  "philosophy",
  "hermeticism",
  "physics",
  "psychedelics",
  "ai",
];

export interface Plan {
  domain: Domain;
  topic: string;
  angle: string;
  title: string;
  source_refs: string[];
}

const SOURCE_PREVIEW_CHARS = 700;

export async function plan(
  style: string,
  recentTomos: TomoSummary[],
  longArc: ContextItem[],
  recent: ContextItem[],
  steer?: string
): Promise<Plan> {
  if (!config.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the planner");
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const formatItem = (c: ContextItem): string => {
    const head = `[${c.kind}:${c.uuid}] ${c.date}${c.title ? " — " + c.title : ""}`;
    const body = c.text.slice(0, SOURCE_PREVIEW_CHARS);
    return `${head}\n${body}`;
  };

  const longArcBlock =
    longArc.length === 0
      ? "(none yet)"
      : longArc.map(formatItem).join("\n\n---\n\n");

  const recentBlock =
    recent.length === 0
      ? "(none)"
      : recent.map(formatItem).join("\n\n---\n\n");

  const recentTomosBlock =
    recentTomos.length === 0
      ? "(none yet — this is tomo 1)"
      : recentTomos
          .map((c) => `#${c.n} [${c.domain}] ${c.title} — ${c.topic}`)
          .join("\n");

  const steerBlock = steer
    ? [
        "# Editorial direction for this tomo (highest priority)",
        "The reader has given a specific redirect. Honor it unless it conflicts with the hard rules (domain enum, B1-level).",
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
    recentTomosBlock,
    "",
    ...steerBlock,
    "# Standing themes — anchor on these",
    "(Older approved insights, distilled over months. The chosen tomo should anchor on a pattern from this block.)",
    "",
    longArcBlock,
    "",
    "# Recent material — last 14 days (use as fresh substrate)",
    "(Recent journal entries and approved insights. Use these for live texture, voice, and sensory specifics.)",
    "",
    recentBlock,
    "",
    "Pick the next tomo. Anchor on a Standing theme; weave in Recent material. Output JSON only.",
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
  const allUuids = new Set<string>([
    ...longArc.map((c) => c.uuid),
    ...recent.map((c) => c.uuid),
  ]);
  validatePlan(parsed, allUuids);
  return parsed;
}

function normalizeUuid(ref: string): string {
  return ref.replace(/^(entry|insight):/, "").trim();
}

function validatePlan(p: Plan, allUuids: Set<string>): void {
  const unknown = p.source_refs.filter((u) => !allUuids.has(u));
  if (unknown.length > 0) {
    throw new Error(
      `Planner picked source UUIDs not in the context pool: ${unknown.join(", ")}`
    );
  }
  if (p.source_refs.length < 1) {
    throw new Error("Planner must pick at least 1 source UUID");
  }
  if (!VALID_DOMAINS.includes(p.domain)) {
    throw new Error(
      `Planner returned invalid domain: ${p.domain}. Must be one of ${VALID_DOMAINS.join(", ")}`
    );
  }
}
